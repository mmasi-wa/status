# Winner Systems Status

## Setup (about 10 minutes)
1. Create a free account at https://resend.com. Create an API key.
   - Free tier note: until you verify a domain in Resend, it only delivers to the email address the account was created with.
     Easiest fix: verify winnerauto.com in Resend (Domains > Add), then change `alertFrom` in `sources.json`
     to something like `Winner Status <status@winnerauto.com>`.
2. Create a new GitHub repository (private is fine) and upload everything in this folder, including the `.github` folder.
3. Repo > Settings > Secrets and variables > Actions > New secret: name `RESEND_API_KEY`, value = your key.
4. Repo > Settings > Pages > Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
   (Pages on a private repo needs a paid GitHub plan; use a public repo if the status data is not sensitive.)
5. Repo > Actions > "Check statuses" > Run workflow. Your dashboard is then at https://YOUR-USER.github.io/YOUR-REPO/

## Adding or changing a monitor
Edit `sources.json` on GitHub (pencil icon) and commit. Types: `statuspage` (any Atlassian Statuspage site),
`pageload` (does it load / show a down message), `googleworkspace`.
`include` / `exclude` are regular expressions matched against "Group / Component" names.

## Notes
- GitHub's scheduler runs about every 5 minutes, and can lag during busy periods.
- An alert needs 2 consecutive bad reads (change `failuresBeforeAlert`). Maintenance never triggers an alert.
- If a page can't be read twice in a row you get an alert saying so.
