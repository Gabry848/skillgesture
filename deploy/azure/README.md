# Deploy SkillGesture to Azure

Host the MCP backend and administration console independently of other products.
The foundation reserves a dedicated resource group, a managed database, a private
network, a container registry, Key Vault, managed identities and a Static Web App.
No custom domain purchase is needed. The backend uses an Azure Container Apps
hostname and the console uses an Azure Static Web Apps hostname, both with HTTPS.

Preparation does not publish application code. GitHub deployment runs only when
manually dispatched with a full commit SHA already merged into `main`. Other
commits, pushes and pull requests can continue while the infrastructure is prepared.

## Prepare the foundation

Requirements: Node 24+, Azure CLI with Bicep, GitHub CLI, and an Azure account with
permission to provision resources and assign roles in the intended subscription.
Sign in using `az login` and `gh auth login` when needed.

```sh
node deploy/azure/prepare.mjs \
  --subscription <subscription-uuid> \
  --configure-github
```

Defaults: `rg-skillgesture`, backend and database in North Europe, PostgreSQL 18 on Burstable B1ms with
32 GiB storage and seven-day backups, ACR Basic, and Static Web Apps Standard.
Static Web Apps uses East US 2 for its control plane; static assets are distributed
globally and application data stays in the private North Europe database. Override
the regions with `--location` and `--dashboard-location` when needed. West Europe
currently restricts new customers, and Static Web Apps does not support North Europe.
An existing resource group's metadata region is preserved; application resources
use their own regions and do not inherit the group's metadata location.
Container Apps uses the Consumption workload profile. The application starts
with zero minimum replicas and at most two replicas; idle periods can cause a
cold start. Set `minReplicas=1` in the application deployment when continuous
availability is preferable to scaling to zero. These services consume Azure
credits while provisioned, including before application publication. The database
and registry have ongoing charges; review the Azure cost view for this group.

The script refuses a resource group that is not tagged for SkillGesture. On
macOS, it generates the database password and saves it in Keychain before any
deployment, allowing recovery after a partial failure. Elsewhere, inject
`SKILLGESTURE_DB_PASSWORD` from a secret manager. Reuse the same password when
rerunning preparation. Do not remove its Keychain entry while the database exists.
Secure deployment parameters use a temporary file with mode 0600 and are removed
when the command ends. Database credentials are stored in Azure Key Vault and
are never output. Local metadata is saved to ignored `.tmp/azure/prepared.json`.

Postgres has no public endpoint. Container Apps and the manual operator job reach
it through the private network and private DNS, with TLS certificate verification.
Registry admin credentials are disabled. The backend identity can pull images and
read vault secrets; the operator identity can also store newly generated agent
tokens. CI uses GitHub OIDC scoped to this repository's `main` branch, with
Contributor access only to the dedicated resource group and AcrPush on its registry.
Preparation reads the repository's OIDC configuration so the Azure federation
uses its exact subject, including immutable owner/repository IDs when enabled.
It refuses custom subject templates that need a separate federation setup.
It has no role-assignment permission. The signed-in operator receives secret access
only on the dedicated vault.

`--configure-github` writes seven non-secret repository variables. It does not
push commits, open a PR, register a custom domain or change another resource group.
All three Bicep templates can be compiled before accessing Azure:

```sh
az bicep build --file deploy/azure/foundation.bicep
az bicep build --file deploy/azure/permissions.bicep
az bicep build --file deploy/azure/application.bicep
node --test deploy/azure/*.test.mjs
```

For remote validation after creating the dedicated group, use
`prepare.mjs --subscription <uuid> --validate-only`. Foundation outputs include
the intended MCP URL, but that URL becomes reachable only after the application
is deployed. Static Web Apps also needs its first content deployment.

## Publish the finished version

Merge the deployment files and the intended product changes into `main`. In
GitHub Actions, run **Deploy SkillGesture to Azure** from `main` and supply the
full 40-character SHA of the release commit. The workflow verifies membership in
`main`, runs backend and dashboard tests, builds an amd64 Linux image, publishes
it to ACR and deploys by immutable digest. It then publishes `dashboard/dist` and
checks database readiness, required MCP authentication and the exact dashboard
CORS origin. It uses the configuration values from the foundation; no frontend
secret is embedded in the static build.

Azure terminates HTTPS at the ingress. The application listens on `0.0.0.0:8080`
with `TRUST_PROXY=1`, its canonical `/mcp` public URL, and the hosted console's
origin in `ALLOWED_ORIGINS`. A digest and commit are reported in the workflow
summary, so later pushes do not silently change the deployed version.

## Initialize access after the first deploy

Start the manual bootstrap job once from the Azure portal or CLI:

```sh
az containerapp job start --name skillgesture-bootstrap --resource-group rg-skillgesture
az containerapp job execution list --name skillgesture-bootstrap --resource-group rg-skillgesture
```

The job runs inside the database's private network. It initializes the schema,
creates an account and a 30-day admin token, then stores that token directly as
`catalog-admin-token` in Key Vault. Logs contain only the account ID and status.
Rerunning it reuses a valid token; it does not rotate or resurrect an expired or
revoked token. Retrieve the token through Key Vault into a secret manager and use
it to connect the console. Create separate agent identities for MCP consumers.

The cloud catalog starts empty. Importing an existing local catalog is a separate
operator task; the local database and catalog are never copied by the deployment
workflow. Once access is initialized, verify an authenticated MCP call through the
console or an agent before declaring the service ready for use.

## Updates and rollback

Dispatch the workflow with another tested SHA already on `main`. Re-dispatching
an earlier SHA that includes these deployment files restores its application image
and dashboard. PostgreSQL data remains in place. App rollback does not undo schema
or catalog changes; assess compatibility before selecting an older version.
The schema initializer currently supports version 1 and serializes initialization.
The templates retain a small number of inactive Container Apps revisions.

Use PostgreSQL's managed backup/restore features for data recovery. Deleting the
resource group also removes its database; it is not a rollback procedure.

References: [Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview),
[private network integration](https://learn.microsoft.com/en-us/azure/container-apps/vnet-custom),
[GitHub OIDC](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect),
[PostgreSQL TLS](https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls-how-to-connect).
