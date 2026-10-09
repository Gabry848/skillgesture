targetScope = 'resourceGroup'
param registryName string
param vaultName string
param runtimePrincipalId string
param operatorPrincipalId string
param deployPrincipalId string
param ownerPrincipalId string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }

var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var acrPush = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
var secretReader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var secretOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
var contributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')

resource imageReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principal in [runtimePrincipalId, operatorPrincipalId]: {
  name: guid(registry.id, principal, acrPull)
  scope: registry
  properties: { principalId: principal, principalType: 'ServicePrincipal', roleDefinitionId: acrPull }
}]
resource imageWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployPrincipalId, acrPush)
  scope: registry
  properties: { principalId: deployPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: acrPush }
}
resource runtimeSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, runtimePrincipalId, secretReader)
  scope: vault
  properties: { principalId: runtimePrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: secretReader }
}
resource operatorSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorPrincipalId, secretOfficer)
  scope: vault
  properties: { principalId: operatorPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: secretOfficer }
}
resource ownerSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, ownerPrincipalId, secretOfficer)
  scope: vault
  properties: { principalId: ownerPrincipalId, principalType: 'User', roleDefinitionId: secretOfficer }
}
// CI can update only this resource group; it cannot grant Azure roles.
resource deployResources 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployPrincipalId, contributor)
  properties: { principalId: deployPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: contributor }
}
