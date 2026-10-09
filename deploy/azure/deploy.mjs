import { parseArgs } from 'node:util';
import { root, azureJson, deployTemplate, unwrap, run, assertSubscription } from './common.mjs';

const { values } = parseArgs({ options: {
  image: { type: 'string' }, commit: { type: 'string' }, subscription: { type: 'string' },
  'resource-group': { type: 'string', default: 'rg-skillgesture' },
  registry: { type: 'string' }, vault: { type: 'string' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node deploy/azure/deploy.mjs --subscription <uuid> --registry <name> --vault <name> --commit <40-character-sha> --image <registry>/skillgesture@sha256:<digest>');
  process.exit(0);
}
if (!/^[0-9a-f]{40}$/i.test(values.commit ?? '')) throw new Error('An immutable full commit SHA is required');
if (!/^[a-z0-9]+$/.test(values.registry ?? '') || !/^[a-z0-9-]+$/.test(values.vault ?? '')) throw new Error('Registry and vault names are required');
if (!new RegExp(`^${values.registry}\\.azurecr\\.io/skillgesture@sha256:[a-f0-9]{64}$`).test(values.image ?? '')) throw new Error('Use a digest-pinned image from the prepared registry');
if (!/^rg-skillgesture(?:-[a-z0-9-]+)?$/.test(values['resource-group'])) throw new Error('Use the dedicated resource group');
assertSubscription(await azureJson(['account', 'show']), values.subscription);
const group = await azureJson(['group', 'show', '--name', values['resource-group']]);
if (group.tags?.application !== 'skillgesture') throw new Error('Resource group ownership does not match SkillGesture');
const location = (await azureJson(['resource', 'show', '--ids', `${group.id}/providers/Microsoft.App/managedEnvironments/skillgesture-environment`, '--query', 'location'])).replace(/\s+/g, '').toLowerCase();
const result = await deployTemplate(`skillgesture-app-${values.commit.slice(0, 12)}`, group.name, 'application.bicep', {
  location, image: values.image, revision: `r${values.commit.slice(0, 12)}-${Date.now().toString(36)}`, registryName: values.registry, vaultName: values.vault,
});
const endpoints = unwrap(result);
await run(process.execPath, [`${root}deploy/azure/verify.mjs`, '--api', endpoints.apiUrl, '--dashboard', endpoints.dashboardUrl, '--backend-only']);
console.log(JSON.stringify({ deployedCommit: values.commit, image: values.image, ...endpoints }, null, 2));
