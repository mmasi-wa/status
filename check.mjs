// Winner Status checker. Node 20+, no dependencies.
// Reads sources.json, writes data/status.json, emails on state changes via Resend.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('sources.json', 'utf8'));
const OUT = 'data/status.json';
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { sources: {} };
const SEV = { operational: 0, maintenance: 0, degraded: 1, partial: 2, major: 3, unknown: 1 };
const now = new Date().toISOString();

const get = async (url, asJson = true) => {
  const r = await fetch(url, { headers: { 'user-agent': 'WinnerStatus/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return asJson ? r.json() : r.text();
};
const worst = (list) => list.reduce((a, b) => (SEV[b] > SEV[a] ? b : a), 'operational');
const SP = { operational: 'operational', degraded_performance: 'degraded', partial_outage: 'partial',
  major_outage: 'major', under_maintenance: 'maintenance' };

async function statuspage(s) {
  const base = s.url.replace(/\/+$/, '');
  const d = await get(`${base}/api/v2/summary.json`);
  const groups = Object.fromEntries(d.components.filter(c => c.group).map(c => [c.id, c.name]));
  const inc = s.include && new RegExp(s.include, 'i'), exc = s.exclude && new RegExp(s.exclude, 'i');
  const comps = d.components.filter(c => !c.group).map(c => ({
    id: c.id, name: (groups[c.group_id] ? groups[c.group_id] + ' / ' : '') + c.name, status: SP[c.status] || 'unknown'
  })).filter(c => (!inc || inc.test(c.name)) && (!exc || !exc.test(c.name)));
  if (!comps.length) throw new Error('No components matched the include/exclude filter');
  const ids = new Set(comps.map(c => c.id));
  const incidents = (d.incidents || [])
    .filter(i => !s.include || (i.components || []).some(c => ids.has(c.id)))
    .map(i => ({ title: i.name, update: i.incident_updates?.[0]?.body || '', url: i.shortlink, at: i.updated_at }));
  const maint = (d.scheduled_maintenances || []).filter(m => m.status === 'in_progress')
    .map(m => ({ title: m.name, update: 'Maintenance in progress', url: m.shortlink, at: m.updated_at }));
  const status = worst(comps.map(c => c.status));
  return { status, components: comps, incidents: [...incidents, ...maint],
    detail: status === 'operational' ? 'All monitored components operational' : `${comps.filter(c => c.status !== 'operational').length} component(s) affected` };
}

async function pageload(s) {
  const html = await get(s.url, false);
  const bad = new RegExp(s.downPattern, 'i').exec(html);
  return bad ? { status: 'major', detail: `Page shows a down message: "${bad[0]}"`, incidents: [], components: [] }
             : { status: 'operational', detail: 'Page loads, no down banner', incidents: [], components: [] };
}

async function googleworkspace(s) {
  const list = await get(s.url);
  const open = list.filter(i => !i.end);
  const status = open.length ? worst(open.map(i => (i.severity === 'high' ? 'major' : 'degraded'))) : 'operational';
  return { status, components: [],
    incidents: open.map(i => ({ title: (i.affected_products || []).map(p => p.title).join(', ') || 'Google Workspace',
      update: i.most_recent_update?.text || i.external_desc || '', url: s.link, at: i.modified || i.begin })),
    detail: open.length ? `${open.length} open incident(s)` : 'No open incidents' };
}

const adapters = { statuspage, pageload, googleworkspace };

async function sendEmail(subject, text) {
  if (!process.env.RESEND_API_KEY) { console.log('No RESEND_API_KEY; would send:', subject); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.alertFrom, to: [cfg.alertTo], subject, text })
  });
  if (!r.ok) throw new Error(`Email failed: ${r.status} ${await r.text()}`);
}

const out = { updated: now, sources: {} };
let changed = false;

for (const s of cfg.sources) {
  const p = prev.sources[s.id] || {};
  let res;
  try { res = await adapters[s.type](s); res.fails = 0; res.error = null; }
  catch (e) {
    res = { status: 'unknown', detail: `Can't read this page: ${e.message}`, incidents: [], components: [],
      fails: (p.fails || 0) + 1, error: e.message };
  }
  const bad = SEV[res.status] > 0;
  const confirmed = res.status === 'unknown' ? res.fails >= cfg.failuresBeforeAlert : true;
  // alert state: 'ok' or 'alerting'. Real problems alert on first sight of two consecutive reads.
  const streak = bad ? (p.badStreak || 0) + 1 : 0;
  const wasAlerting = p.alerting === true;
  let alerting = wasAlerting;
  if (bad && confirmed && streak >= (res.status === 'unknown' ? 1 : cfg.failuresBeforeAlert)) alerting = true;
  if (!bad) alerting = false;

  try {
    if (alerting && !wasAlerting) {
      const lines = [res.detail, ...res.components.filter(c => c.status !== 'operational').map(c => `- ${c.name}: ${c.status}`),
        ...res.incidents.map(i => `\n${i.title}\n${i.update.slice(0, 400)}\n${i.url || ''}`), `\n${s.link}`];
      await sendEmail(`DOWN: ${s.name} is ${res.status}`, lines.join('\n'));
    } else if (!alerting && wasAlerting) {
      await sendEmail(`RECOVERED: ${s.name}`, `${s.name} is back to ${res.status}.\n\n${s.link}`);
    }
  } catch (e) { console.error(e.message); alerting = wasAlerting; }  // retry email next run

  const lastChange = p.status !== res.status ? now : (p.lastChange || now);
  if (p.status !== res.status || p.detail !== res.detail || JSON.stringify(p.incidents) !== JSON.stringify(res.incidents)) changed = true;
  out.sources[s.id] = { name: s.name, link: s.link, ...res, badStreak: streak, alerting, lastChange, checked: now };
}

// Only write (and thus commit) when something changed, or every 30 min as a heartbeat.
const age = prev.updated ? (Date.now() - new Date(prev.updated)) / 60000 : Infinity;
if (changed || age >= 30) { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log('Wrote status.json'); }
else console.log('No change; skipped write');
