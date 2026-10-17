// Pitstop on Azure. Deployed only by .github/workflows/infra.yml, never from a laptop.
//
// Two-pass deploy (the workflow does both):
//   1. deployApp=false -> registry, database, Container Apps environment, identity
//   2. image pushed to the registry, then deployApp=true -> the Container App itself
// This avoids starting the app before its image exists.

targetScope = 'resourceGroup'

@description('Short name used as a prefix for every resource.')
@minLength(3)
@maxLength(12)
param prefix string = 'pitstop'

@description('Azure region. Defaults to the resource group region.')
param location string = resourceGroup().location

@description('Postgres admin user name.')
param pgAdminUser string = 'pitstop'

@description('Postgres admin password. Use letters and digits only (it goes into a connection URL).')
@secure()
param pgAdminPassword string

@description('Deploy the Container App (pass 2). False on the first pass, before the image exists.')
param deployApp bool = false

@description('Full image reference, e.g. myacr.azurecr.io/server:<sha>. Required when deployApp is true.')
param containerImage string = ''

@description('Claude API key for AI repair (Phase 4). Leave empty until then.')
@secure()
param anthropicApiKey string = ''

var suffix = uniqueString(resourceGroup().id)
// Registry names allow only letters and digits.
var acrName = take('${replace(toLower(prefix), '-', '')}acr${suffix}', 50)
var pgName = '${prefix}-pg-${suffix}'
var dbName = 'pitstop'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// ---------- Logs ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------- Container registry (images built by CI) ----------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

// The app pulls images with this identity instead of a registry password.
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-app-id'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, appIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

// ---------- Postgres with pgvector ----------
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' = {
  name: pgName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32 }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
  }
}

// Allowlist pgvector so `create extension vector` works in the migration.
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2022-12-01' = {
  parent: pg
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR'
    source: 'user-override'
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = {
  parent: pg
  name: dbName
  dependsOn: [pgExtensions]
}

// 0.0.0.0 - 0.0.0.0 means "allow Azure services", which includes Container Apps.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2022-12-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [pgDb]
}

// ---------- Container Apps ----------
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var databaseUrl = 'postgresql://${pgAdminUser}:${pgAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'

var baseSecrets = [
  { name: 'database-url', value: databaseUrl }
]
var aiSecrets = empty(anthropicApiKey) ? [] : [
  { name: 'anthropic-api-key', value: anthropicApiKey }
]
var baseEnv = [
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'PORT', value: '8080' }
]
var aiEnv = empty(anthropicApiKey) ? [] : [
  { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
]

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: '${prefix}-server'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: appIdentity.id
        }
      ]
      secrets: concat(baseSecrets, aiSecrets)
    }
    template: {
      containers: [
        {
          name: 'server'
          image: containerImage
          env: concat(baseEnv, aiEnv)
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 10
              periodSeconds: 15
              failureThreshold: 4
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      // One replica: the stream keeps subscribers in memory (see server/CLAUDE.md).
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [acrPull, pgAllowAzure]
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output postgresHost string = pg.properties.fullyQualifiedDomainName
output appName string = '${prefix}-server'
output appFqdn string = deployApp ? app!.properties.configuration.ingress.fqdn : ''
