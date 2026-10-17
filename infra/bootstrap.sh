#!/usr/bin/env bash
# One-time setup: lets GitHub Actions deploy to Azure without any stored Azure password.
# Run once, from a laptop, by the subscription owner. After this, nobody deploys from a laptop.
#
# What it does:
#   1. registers the Azure resource providers the project needs
#   2. creates the resource group
#   3. creates an Entra ID app + service principal for GitHub Actions
#   4. grants it rights on that resource group only
#   5. trusts GitHub's OIDC tokens from this repo's "production" environment (federated credential)
#   6. creates the GitHub environment and stores IDs, the DB password and settings as GitHub secrets/variables
#
# Requirements: az CLI (logged in: `az login`), gh CLI (logged in: `gh auth login`), openssl.
# Usage:
#   GITHUB_REPO=owner/pitstop bash infra/bootstrap.sh
# Optional: RG=pitstop-rg LOCATION=westeurope PREFIX=pitstop

set -euo pipefail
# Stops Git Bash (MSYS) on Windows rewriting Azure IDs like /subscriptions/... into Windows paths.
export MSYS_NO_PATHCONV=1
# az on Windows ends its output lines with CRLF; strip the \r so captured IDs and secrets stay clean.
az() { command az "$@" | tr -d '\r'; }

: "${GITHUB_REPO:?Set GITHUB_REPO=owner/repo}"
RG="${RG:-pitstop-rg}"
LOCATION="${LOCATION:-westeurope}"
PREFIX="${PREFIX:-pitstop}"
APP_NAME="${APP_NAME:-pitstop-github-actions}"
GH_ENV="production"

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
echo "Subscription: $(az account show --query name -o tsv) ($SUBSCRIPTION_ID)"
echo "Repo: $GITHUB_REPO   Resource group: $RG   Region: $LOCATION"
read -r -p "Continue? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1

echo "==> Registering resource providers (can take a few minutes the first time)"
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$ns" --wait >/dev/null
done

echo "==> Resource group"
az group create --name "$RG" --location "$LOCATION" >/dev/null
SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG"

echo "==> Entra ID app and service principal for GitHub Actions"
APP_ID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
fi
az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null
SP_OBJECT_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"

echo "==> Role assignments on $RG only"
# Contributor: create resources, push images to the registry.
# Role Based Access Control Administrator: lets the Bicep grant the app's identity AcrPull.
for role in "Contributor" "Role Based Access Control Administrator"; do
  az role assignment create \
    --assignee-object-id "$SP_OBJECT_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$role" \
    --scope "$SCOPE" >/dev/null 2>&1 || echo "    ($role already assigned)"
done

echo "==> Federated credential: trust GitHub OIDC tokens from environment '$GH_ENV'"
# Repos created after 2026-07-15 get immutable OIDC subjects: owner and repo names carry their
# numeric IDs, e.g. repo:octo-org@123/octo-repo@456:environment:production. Build it from the API.
OIDC_REPO="$(gh api "repos/$GITHUB_REPO" --jq '"\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"')"
SUBJECT="repo:$OIDC_REPO:environment:$GH_ENV"
CRED_NAME="github-$GH_ENV"
CRED_JSON="{
    \"name\": \"$CRED_NAME\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$SUBJECT\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"
CURRENT_SUBJECT="$(az ad app federated-credential show --id "$APP_ID" --federated-credential-id "$CRED_NAME" --query subject -o tsv 2>/dev/null || true)"
if [[ -z "$CURRENT_SUBJECT" ]]; then
  az ad app federated-credential create --id "$APP_ID" --parameters "$CRED_JSON" >/dev/null
elif [[ "$CURRENT_SUBJECT" != "$SUBJECT" ]]; then
  echo "    (updating subject: $CURRENT_SUBJECT -> $SUBJECT)"
  az ad app federated-credential update --id "$APP_ID" --federated-credential-id "$CRED_NAME" --parameters "$CRED_JSON" >/dev/null
fi

echo "==> GitHub environment, secrets and variables"
gh api --method PUT "repos/$GITHUB_REPO/environments/$GH_ENV" >/dev/null
gh secret set AZURE_CLIENT_ID       --repo "$GITHUB_REPO" --body "$APP_ID"
gh secret set AZURE_TENANT_ID       --repo "$GITHUB_REPO" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$SUBSCRIPTION_ID"
if ! gh secret list --repo "$GITHUB_REPO" | grep -q '^PG_ADMIN_PASSWORD'; then
  # Letters and digits only: it is embedded in the connection URL.
  gh secret set PG_ADMIN_PASSWORD --repo "$GITHUB_REPO" --body "$(openssl rand -hex 24)"
fi
gh variable set AZURE_RESOURCE_GROUP --repo "$GITHUB_REPO" --body "$RG"
gh variable set AZURE_LOCATION       --repo "$GITHUB_REPO" --body "$LOCATION"
gh variable set APP_PREFIX           --repo "$GITHUB_REPO" --body "$PREFIX"

echo
echo "Done. Next: GitHub -> Actions -> 'Provision infrastructure' -> Run workflow."
echo "Later, for AI repair (Phase 4): gh secret set ANTHROPIC_API_KEY --repo $GITHUB_REPO, then re-run that workflow."
