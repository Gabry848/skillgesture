targetScope = 'resourceGroup'
param location string
param image string
param revision string
param prefix string = 'skillgesture'
param registryName string
param vaultName string
param minReplicas int = 0
param maxReplicas int = 2

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' existing = { name: '${prefix}-environment' }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }
resource dashboard 'Microsoft.Web/staticSites@2024-11-01' existing = { name: '${prefix}-console' }
resource runtime 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: '${prefix}-runtime' }
resource operator 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: '${prefix}-operator' }

var databaseSecret = '${vault.properties.vaultUri}secrets/database-url'
var apiUrl = 'https://${prefix}-api.${environment.properties.defaultDomain}/mcp'
var databaseEnv = [{ name: 'DATABASE_URL', secretRef: 'database-url' }]

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: '${prefix}-api'
  location: location
  tags: { application: 'skillgesture', managedBy: 'skillgesture-azure' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${runtime.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 5
      ingress: { external: true, targetPort: 8080, transport: 'http', allowInsecure: false }
      registries: [{ server: registry.properties.loginServer, identity: runtime.id }]
      secrets: [{ name: 'database-url', keyVaultUrl: databaseSecret, identity: runtime.id }]
    }
    template: {
      revisionSuffix: revision
      containers: [{
        name: 'skillgesture'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(databaseEnv, [
          { name: 'HOST', value: '0.0.0.0' }
          { name: 'PORT', value: '8080' }
          { name: 'TRUST_PROXY', value: '1' }
          { name: 'PUBLIC_URL', value: apiUrl }
          { name: 'ALLOWED_ORIGINS', value: 'https://${dashboard.properties.defaultHostname}' }
        ])
        probes: [
          { type: 'Startup', httpGet: { path: '/health', port: 8080 }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 }
          { type: 'Readiness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
          { type: 'Liveness', tcpSocket: { port: 8080 }, periodSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 }
        ]
      }]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '20' } } }]
      }
    }
  }
}
resource bootstrap 'Microsoft.App/jobs@2025-07-01' = {
  name: '${prefix}-bootstrap'
  location: location
  tags: { application: 'skillgesture', managedBy: 'skillgesture-azure' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${operator.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registry.properties.loginServer, identity: operator.id }]
      secrets: [{ name: 'database-url', keyVaultUrl: databaseSecret, identity: operator.id }]
    }
    template: {
      containers: [{
        name: 'bootstrap'
        image: image
        command: ['node', 'deploy/azure/bootstrap.mjs']
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(databaseEnv, [
          { name: 'KEY_VAULT_URL', value: vault.properties.vaultUri }
          { name: 'AZURE_CLIENT_ID', value: operator.properties.clientId }
        ])
      }]
    }
  }
}

output apiUrl string = apiUrl
output dashboardUrl string = 'https://${dashboard.properties.defaultHostname}'
