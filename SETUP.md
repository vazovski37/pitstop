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
Optional settings: `RG=pitstop-rg LOCATION=westeurope PREFIX=pitstop` (prefix: lowercase letters and digits, 3 to 12 characters).

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

## Later

**Claude API key for AI repair (Phase 4)**
```bash
gh secret set ANTHROPIC_API_KEY --repo <you>/pitstop
```
Then run **Provision infrastructure** again; it adds the key to the app as a secret. Your Claude Max plan covers Claude Code on your laptops, but the server's own model calls need this separate key (or a Microsoft Foundry deployment; check whether your Azure credits cover Claude there first).

**Live view (Phase 5)**
Add a second Container App or an Azure Static Web App in `infra/main.bicep`, and a deploy job for `web/` in `deploy.yml`.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `AADSTS700213: No matching federated identity record found` | The job's environment or repo name does not match the federated credential. It must be `repo:<owner>/pitstop:environment:production`. Re-run `bootstrap.sh` with the exact `GITHUB_REPO`. |
| `AuthorizationFailed` on `roleAssignments/write` | The service principal lacks "Role Based Access Control Administrator" on the resource group. Re-run `bootstrap.sh`, or assign it in the portal (or "User Access Administrator"). |
| Postgres: `LocationIsOfferRestricted` or capacity error | Some regions limit new database servers on credit-based subscriptions. Re-run `bootstrap.sh` with `RG=pitstop-rg2 LOCATION=germanywestcentral` (or `swedencentral`, `northeurope`), then Provision. |
| `MissingSubscriptionRegistration` | Providers not registered yet. `bootstrap.sh` does it; wait a few minutes and re-run Provision. |
| Deploy fails at "Smoke test" | The new revision did not report the new commit with a working database. The workflow already rolled back. Check logs: Azure portal → Container App → Log stream. |
| `extension "vector" is not allow-listed` | The `azure.extensions` setting did not apply. Re-run Provision. |
