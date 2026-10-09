targetScope = 'resourceGroup'

@description('Azure region shared by the backend and database.')
param location string = 'northeurope'
@description('Static Web Apps control-plane region; frontend assets are distributed globally.')
@allowed(['centralus', 'eastus2', 'westus2', 'westeurope', 'eastasia'])
param dashboardLocation string = 'eastus2'
param prefix string = 'skillgesture'
@secure()
param databasePassword string
param databaseVersion string = '18'
@description('Exact GitHub OIDC subject for main, including immutable IDs when enabled.')
param githubOidcSubject string
@allowed(['Free', 'Standard'])
param dashboardPlan string = 'Standard'

var suffix = uniqueString(resourceGroup().id)
var tags = { application: 'skillgesture', managedBy: 'skillgesture-azure' }
var appName = '${prefix}-api'

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-network'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.84.0.0/16'] }
    subnets: [
      {
        name: 'containers'
        properties: {
          addressPrefix: '10.84.0.0/23'
          delegations: [{ name: 'containers', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.84.2.0/28'
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

resource databaseDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${prefix}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}
resource databaseDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: databaseDns
  name: '${prefix}-network'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: databaseVersion
    administratorLogin: 'skillgesture_operator'
    administratorLoginPassword: databasePassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'postgres')
      privateDnsZoneArmResourceId: databaseDns.id
    }
  }
  dependsOn: [databaseDnsLink]
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'skillgesture'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'sg${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'sg-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    accessPolicies: []
  }
}
resource databaseUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: {
    value: 'postgresql://skillgesture_operator:${uriComponent(databasePassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/skillgesture?sslmode=verify-full'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.25') }
  }
}
resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: '${prefix}-environment'
  location: location
  tags: tags
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: {
      internal: false
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'containers')
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}
resource dashboard 'Microsoft.Web/staticSites@2024-11-01' = {
  name: '${prefix}-console'
  location: dashboardLocation
  tags: tags
  sku: { name: dashboardPlan, tier: dashboardPlan }
  properties: { allowConfigFileUpdates: true }
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-runtime'
  location: location
  tags: tags
}
resource operatorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-operator'
  location: location
  tags: tags
}
resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-deploy'
  location: location
  tags: tags
}
resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-main'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    audiences: ['api://AzureADTokenExchange']
    subject: githubOidcSubject
  }
}

// This endpoint becomes reachable only after application.bicep is deployed.
output apiUrl string = 'https://${appName}.${environment.properties.defaultDomain}/mcp'
output dashboardUrl string = 'https://${dashboard.properties.defaultHostname}'
output containerAppName string = appName
output environmentName string = environment.name
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output vaultName string = vault.name
output postgresName string = postgres.name
output dashboardName string = dashboard.name
output runtimeIdentityName string = runtimeIdentity.name
output operatorIdentityName string = operatorIdentity.name
output runtimePrincipalId string = runtimeIdentity.properties.principalId
output operatorPrincipalId string = operatorIdentity.properties.principalId
output deployPrincipalId string = deployIdentity.properties.principalId
output deployClientId string = deployIdentity.properties.clientId
output tenantId string = tenant().tenantId
output subscriptionId string = subscription().subscriptionId
