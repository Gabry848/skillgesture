import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, run, az, azureJson, deployTemplate, unwrap, assertSubscription, githubVariables, githubMainSubject } from './common.mjs';

const { values } = parseArgs({ options: {
  subscription: { type: 'string' },
  'resource-group': { type: 'string', default: 'rg-skillgesture' },
  location: { type: 'string', default: 'northeurope' },
  'dashboard-location': { type: 'string', default: 'eastus2' },
  'github-repository': { type: 'string', default: 'gabry848/skillgesture' },
  'configure-github': { type: 'boolean', default: false },
  'validate-only': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node deploy/azure/prepare.mjs --subscription <uuid> [--configure-github] [--validate-only]\nCreates the dedicated foundation, private Postgres, Key Vault and CI identity. Does not publish application code.');
  process.exit(0);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.subscription ?? '')) throw new Error('--subscription must identify the intended Azure subscription');
if (!/^rg-skillgesture(?:-[a-z0-9-]+)?$/.test(values['resource-group'])) throw new Error('Use a dedicated rg-skillgesture resource group');
const group = values['resource-group'];
const oidc = JSON.parse((await run('gh', ['api', `repos/${values['github-repository']}/actions/oidc/customization/sub`], { capture: true })).stdout);
const githubOidcSubject = githubMainSubject(values['github-repository'], oidc);
await az(['account', 'set', '--subscription', values.subscription]);
assertSubscription(await azureJson(['account', 'show']), values.subscription);
const groupResult = await az(['group', 'show', '--name', group, '--output', 'json'], { capture: true, optional: true });
if (groupResult.code === 0 && JSON.parse(groupResult.stdout).tags?.application !== 'skillgesture') {
  throw new Error('The existing resource group is not tagged for SkillGesture; refusing to change it');
}
if (values['validate-only'] && groupResult.code !== 0) throw new Error('Create the dedicated group before remote validation');

// Save the initial password before provisioning so a partial deployment is recoverable.
const keychainService = `skillgesture.azure.${values.subscription}.${group}`;
let password = process.env.SKILLGESTURE_DB_PASSWORD;
if (!password && process.platform === 'darwin') {
  const existing = await run('security', ['find-generic-password', '-s', keychainService, '-a', 'database', '-w'], { capture: true, optional: true });
  password = existing.code === 0 ? existing.stdout : undefined;
}
if (!password) {
  if (values['validate-only']) throw new Error('Supply the existing database password for validation');
  if (groupResult.code === 0) {
    const databases = await azureJson(['resource', 'list', '--resource-group', group, '--resource-type', 'Microsoft.DBforPostgreSQL/flexibleServers', '--query', '[].name']);
    if (databases.length) throw new Error('Recover the existing database password from your secret manager before rerunning preparation');
  }
  if (process.platform !== 'darwin') throw new Error('Inject SKILLGESTURE_DB_PASSWORD from your secret manager');
  password = `Sg!${randomBytes(36).toString('base64url')}`;
  await run('security', ['add-generic-password', '-s', keychainService, '-a', 'database', '-w', password], { capture: true });
}
if (!values['validate-only']) {
  for (const namespace of ['Microsoft.App', 'Microsoft.DBforPostgreSQL', 'Microsoft.ContainerRegistry', 'Microsoft.KeyVault', 'Microsoft.ManagedIdentity', 'Microsoft.Network', 'Microsoft.OperationalInsights', 'Microsoft.Web']) {
    await az(['provider', 'register', '--namespace', namespace, '--wait', '--output', 'none']);
  }
  const groupLocation = groupResult.code === 0 ? JSON.parse(groupResult.stdout).location : values.location;
  await az(['group', 'create', '--name', group, '--location', groupLocation,
    '--tags', 'application=skillgesture', 'managedBy=skillgesture-azure', '--output', 'none']);
}
console.log(values['validate-only'] ? 'Validating the Azure foundation.' : 'Preparing the Azure foundation; application code remains unpublished.');
const outputs = await deployTemplate('skillgesture-foundation', group, 'foundation.bicep', {
  location: values.location, dashboardLocation: values['dashboard-location'], databasePassword: password, githubOidcSubject,
}, { validate: values['validate-only'] });
if (!values['validate-only']) {
  const state = { ...unwrap(outputs), resourceGroup: group, location: values.location, dashboardLocation: values['dashboard-location'], githubRepository: values['github-repository'], githubOidcSubject, applicationDeployed: false };
  const owner = await azureJson(['ad', 'signed-in-user', 'show', '--query', 'id']);
  await deployTemplate('skillgesture-permissions', group, 'permissions.bicep', {
    registryName: state.registryName, vaultName: state.vaultName,
    runtimePrincipalId: state.runtimePrincipalId, operatorPrincipalId: state.operatorPrincipalId,
    deployPrincipalId: state.deployPrincipalId, ownerPrincipalId: owner,
  });
  await mkdir(join(root, '.tmp', 'azure'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, '.tmp', 'azure', 'prepared.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  if (values['configure-github']) {
    for (const [name, value] of Object.entries(githubVariables(state))) {
      await run('gh', ['variable', 'set', name, '--repo', state.githubRepository, '--body', value]);
    }
  }
  console.log(JSON.stringify({ prepared: true, resourceGroup: group, apiUrl: state.apiUrl, apiPublished: false, dashboardUrl: state.dashboardUrl, githubConfigured: values['configure-github'] }, null, 2));
}
