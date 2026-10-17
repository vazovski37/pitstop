# Setup

Laptops never deploy. GitHub Actions builds, tests and ships to Azure on every push to `main`; Azure only accepts deploys from this repository, through OIDC (no Azure password is stored anywhere).

```
laptop ──git push──▶ GitHub ──CI (tests + image check)──▶ Deploy ──▶ Azure Container Registry
                                                             │
                                                             └──▶ Azure Container Apps ──▶ Azure Postgres (pgvector)
                                                                  smoke test, auto rollback on failure
```

## What runs when

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `CI` | Every pull request and branch push | Typecheck, tests (with a real Postgres + pgvector), builds the server image and checks it starts |
| `Deploy` | Push to `main` touching `server/`, `packages/protocol/` or the lockfile; or by hand | Runs CI, builds the image, pushes it to the registry, rolls out a new revision, checks `/healthz` reports the new commit, rolls back if not |
| `Provision infrastructure` | By hand; or push to `main` touching `infra/main.bicep` | Creates or updates every Azure resource from `infra/main.bicep` |

Deploy and Provision share one concurrency group, so they never run at the same time.

---

## One-time setup (Vazovski, about 30 minutes)

### 1. Tools on your laptop
- Node.js 22, Docker Desktop
- Windows only: Git for Windows (Git Bash): https://git-scm.com/download/win
- Azure CLI: `az login`
- GitHub CLI: `gh auth login`
- Jujutsu: https://jj-vcs.github.io/jj/latest/install-and-setup/

On Windows, run every command in this guide in Git Bash (not PowerShell or cmd). On macOS or Linux, use the normal terminal.

### 2. Create the GitHub repository and push this scaffold
The project folder can live anywhere; nothing in the repo depends on its location. Start from wherever it is on your computer:
```bash
cd <path-to>/pitstop       # e.g. ~/Documents/GitHub/pitstop or ~/code/pitstop
git init -b main
npm install            # package-lock.json is included; CI installs from it
git add -A && git commit -m "Scaffold: monorepo, CI/CD, Azure infrastructure"
gh repo create pitstop --private --source . --push
```
CI runs right away. `Deploy` and `Provision infrastructure` are skipped until step 3.

### 3. Connect GitHub to Azure
Pick the subscription with your credits, then run the bootstrap once:
```bash
az account set --subscription "<your subscription name or id>"
GITHUB_REPO=<your-github-user>/pitstop bash infra/bootstrap.sh
```
Optional settings: `RG=pitstop-rg LOCATION=swedencentral PREFIX=pitstop` (prefix: lowercase letters and digits, 3 to 12 characters).

It registers the Azure resource providers, creates the resource group, creates a service principal that can act only on that group, trusts GitHub's OIDC tokens from this repo's `production` environment, and stores the IDs, a generated database password and the settings in GitHub.

### 4. Create the Azure resources
GitHub → **Actions** → **Provision infrastructure** → **Run workflow**.

The first run takes about 10 to 15 minutes (the database is the slow part). It ends by printing the server URL and checking `https://<app>/healthz`.

### 5. Protect `main`
GitHub → Settings → Branches → add a rule for `main`: require the `CI` checks to pass, require a pull request. From now on the only way to production is a green change on `main`.

Recommended: GitHub → Settings → Environments → `production` → restrict deployments to the `main` branch.

### 6. Add your teammate
GitHub → Settings → Collaborators → invite. They need no Azure access at all.

---

## Second laptop

Any other computer (yours or your teammate's) needs only the tools from step 1 (Azure CLI not required) and access to the GitHub repo. No Azure login, no bootstrap: deploys still happen only through GitHub Actions.

```bash
git clone https://github.com/<you>/pitstop && cd pitstop
cp .env.example .env
npm install
npm run db:up               # local Postgres with pgvector on port 5432
npm test
jj git init --colocate      # optional: jj and git share the same folder
```

- If `db:up` fails with `port is already allocated`, another Postgres on that computer is using port 5432; stop it first.
- `npm test` skips the migration tests unless `DATABASE_URL` is set in the shell: `DATABASE_URL=postgresql://pitstop:pitstop@localhost:5432/pitstop npm test`.

---

## Every day (both of you)

```bash
git clone https://github.com/<you>/pitstop && cd pitstop
jj git init --colocate      # jj and git share the same folder
cp .env.example .env
npm install
npm run db:up               # local Postgres with pgvector
npm run dev:server          # http://localhost:8080/healthz
npm test
```

- Work in the folders you own (see `CLAUDE.md`). Each folder's `CLAUDE.md` tells your Claude what it may touch.
- Until Phase 3: short branches, pull request, merge to `main` when CI is green. Merging to `main` deploys.
- From Phase 3: the repository moves onto Pitstop itself; its git mirror pushes to `main`, which triggers the same deploy.

To see what is running in Azure: Actions → latest `Deploy` run → the `production` environment link, or `https://<app>/healthz` (it shows the deployed commit).

---

## The live view
The server's root URL (`http://localhost:8080/` on a laptop, the Container App's URL on Azure) is the page the judges watch: the log as it grows, open intents, repairs and warnings as they happen. It is built from `web/` into the server image, so it deploys with the server. On a server with `PITSTOP_TOKEN` set, paste that token into the field at the top right once; with accounts on, sign in with GitHub instead. Locally, `npm run build -w @pitstop/web` once, then `npm run dev:server` serves it.

## Joining the hosted service
Pitstop is a hosted service: one server, run by us on Azure, that any team signs in to. Nobody installs a server; developers install only the client (the daemon and the agent tools, `daemon/README.md`). Joining, once accounts are on (see "Accounts" below):

1. Open the server's URL in a browser and sign in with GitHub.
2. Create a personal token on the page (it starts with `pst_` and is shown once) and keep it in `PITSTOP_TOKEN` on your machine.
3. In a checkout of your repository: `pitstop init <server-url> --repo <owner>/<name>` creates the repository on the server and imports the checkout as the log's first entry; your teammates build their worktrees from the log with `pitstop clone <server-url> <owner>/<name>`.
4. Add them as members of the repository (`PUT /repos/<owner>/<name>/members/<login>`; a page for it is on the plan) and start the daemon; everything else is in the guide.

The local stack (`npm run dev:server`, `docker compose up --build`) exists for developing Pitstop itself, not as a way to run it.

## Later

**Server token (Phase 2)**

The server on Azure is public, so one shared token guards everything except `/healthz`. Pick a long random string, store it as a GitHub secret, and run **Provision infrastructure** again:
```bash
gh secret set PITSTOP_TOKEN --repo <you>/pitstop
```
Put the same value in each laptop's `.env` as `PITSTOP_TOKEN`; the daemon sends it as `Authorization: Bearer <token>` (a browser uses `?token=<token>` on `/stream`). Until the secret exists the server runs open.

**Accounts (Phase 5)**

People sign in with GitHub, make personal tokens for their daemons, and are members of repositories. Register an OAuth App at GitHub → Settings → Developer settings → OAuth Apps: homepage `https://<app>`, callback `https://<app>/auth/github/callback`. Then:
```bash
gh variable set GITHUB_OAUTH_CLIENT_ID --repo <you>/pitstop --body <client id>
gh secret set GITHUB_OAUTH_CLIENT_SECRET --repo <you>/pitstop
gh secret set SESSION_SECRET --repo <you>/pitstop      # any long random string
```
and run **Provision infrastructure**. From then on `GET /auth/github` signs in, `POST /tokens {"name": "laptop"}` (with the session cookie) answers a `pst_…` secret once, and that secret goes into the laptop's `.env` as `PITSTOP_TOKEN`: the daemon sends it like the shared one. `POST /repos` by a signed-in user makes them its owner; owners add members (`PUT /repos/<owner>/<name>/members/<login>` with `{"role": "writer"}`) and can make a repository public. The shared `PITSTOP_TOKEN` keeps working as the super-user, and a repository with no members is open to any signed-in user, so nothing breaks the day accounts go on.

**Git mirror (Phase 3)**

Every accepted entry of a mirrored repository becomes a commit on a GitHub branch, built with the same recipe as the daemons' local commits, so CI and deploys keep running from `main` while the repository lives on Pitstop. Make a fine-grained token with **Contents: write** on the repositories to mirror, store it, and run **Provision infrastructure**:
```bash
gh secret set MIRROR_GITHUB_TOKEN --repo <you>/pitstop
```
Then, per repository, after its `pitstop import` from a clean checkout of the branch:
```bash
curl -X PUT "$SERVER/repos/<owner>/<name>/mirror" -H "authorization: Bearer $PITSTOP_TOKEN" -H "content-type: application/json" \
  -d '{"github":"<owner>/<name>","branch":"main","baseCommit":"<the sha the import was made from>"}'
```
`GET /repos/<owner>/<name>/mirror` shows how far it is. A branch that someone else pushes to shows `diverged`; nothing but the mirror should push it. Locally, `MIRROR_GITHUB_TOKEN` in `.env` does the same.

**AI repair (Phase 4)**

Write skew is resolved by whoever `PITSTOP_REPAIR` names. Unset, it is `off`: the validator alone handles skew (`PITSTOP_VALIDATE`, `warn` by default, lands it with a warning). `.env.example` and `infra/main.bicep` set `agent`, which needs nothing: the coding agent that committed is told what changed and commits again; that is what a laptop with `.env` and the Azure server run. For the server to repair with a model, get a free key at console.groq.com and store it:
```bash
gh secret set GROQ_API_KEY --repo <you>/pitstop
```
Then change the `repairMode` default in `infra/main.bicep` from `'agent'` to `'groq'` (and `groqModel` there for another model) and merge it to `main`: that push runs **Provision infrastructure**, which is the only way the mode reaches Azure. The workflow passes no `repairMode` of its own and takes no inputs when run by hand, a plain **Deploy** keeps whatever the last Provision set, and laptops never run `az deployment` (`CLAUDE.md`). Locally, set `PITSTOP_REPAIR=groq` and `GROQ_API_KEY` in `.env`. Your Claude Max plan covers Claude Code on the laptops; the server's own model calls go to Groq.

**Live view (Phase 5)**
Add a second Container App or an Azure Static Web App in `infra/main.bicep`, and a deploy job for `web/` in `deploy.yml`.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `AADSTS700213: No matching federated identity record found` | The job's environment or repo name does not match the federated credential. New repositories use immutable subjects with numeric IDs: `repo:<owner>@<owner-id>/pitstop@<repo-id>:environment:production` (the error message shows the exact one). Re-run `bootstrap.sh` with the exact `GITHUB_REPO`; it builds that subject from the GitHub API. |
| `AuthorizationFailed` on `roleAssignments/write` | The service principal lacks "Role Based Access Control Administrator" on the resource group. Re-run `bootstrap.sh`, or assign it in the portal (or "User Access Administrator"). |
| `RequestDisallowedByAzure`: "The selected region is currently not accepting new customers" | That region is closed to new subscriptions (West Europe was in October 2026). Point the resources at another region: `gh variable set AZURE_LOCATION --repo <you>/pitstop --body swedencentral` (or `northeurope`, `francecentral`), then Provision. The resource group can stay where it is. |
| Postgres: `LocationIsOfferRestricted`, capacity error, or `ParameterOutOfRange`: "The value of the 'Version' should be in: []" | Some regions do not offer new database servers to credit-based subscriptions (Germany West Central did not in October 2026). Check a region first: `az postgres flexible-server list-skus --location <region>` must list version 16 and the SKU in `infra/main.bicep`. Then switch `AZURE_LOCATION` as above. |
| Postgres: `RegionalAllocationFailed`: "We do not have sufficient capacity for the requested compute size" | Azure is out of that server size in the region for now. Retry Provision later, or change the Postgres `sku.name` in `infra/main.bicep` to another size from `list-skus` and push. |
| `ManagedEnvironmentCapacityHeavyUsageError` (`AKSCapacityHeavyUsage`) | Azure has no Container Apps capacity in that region right now. Switch `AZURE_LOCATION` as above. |
| Switching region fails with "resource already exists in location …" | A failed run left resources in the old region, and Azure will not move a name. Delete the leftovers in the resource group (Portal, or `az resource delete`; a Log Analytics workspace needs `az monitor log-analytics workspace delete --force true` to free its name), then Provision. |
| `MissingSubscriptionRegistration` | Providers not registered yet. `bootstrap.sh` does it; wait a few minutes and re-run Provision. |
| Deploy fails at "Smoke test" | The new revision did not report the new commit with a working database. The workflow already rolled back. Check logs: Azure portal → Container App → Log stream. |
| `extension "vector" is not allow-listed` | The `azure.extensions` setting did not apply. Re-run Provision. |
