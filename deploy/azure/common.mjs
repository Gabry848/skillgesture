import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export async function run(command, args, { capture = false, optional = false } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', capture ? 'pipe' : 'inherit', optional ? 'ignore' : 'inherit'] });
    const chunks = [];
    child.stdout?.on('data', chunk => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8').trim() }));
  });
  if (result.code && !optional) throw new Error(`${command} failed (exit ${result.code})`);
  return result;
}
export const az = async (args, options = {}) => run(process.env.AZURE_CLI ?? 'az', [...args, '--only-show-errors'], options);
export async function azureJson(args) {
  const result = await az([...args, '--output', 'json'], { capture: true });
  return JSON.parse(result.stdout);
}
export async function deployTemplate(name, group, template, parameters, { validate = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'skillgesture-azure-parameters-'));
  const path = join(folder, 'parameters.json');
  try {
    await writeFile(path, JSON.stringify({ parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, { value }])) }), { mode: 0o600 });
    return await azureJson(['deployment', 'group', validate ? 'validate' : 'create', '--resource-group', group, '--name', name,
      '--template-file', `deploy/azure/${template}`, '--parameters', `@${path}`, '--query', 'properties.outputs']);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
export function unwrap(outputs) { return Object.fromEntries(Object.entries(outputs ?? {}).map(([key, value]) => [key, value.value])); }
export function assertSubscription(actual, expected) {
  if (actual.id !== expected || actual.state !== 'Enabled') throw new Error('Select the intended enabled Azure subscription before continuing');
}
export function githubVariables(state) {
  return {
    AZURE_CLIENT_ID: state.deployClientId,
    AZURE_TENANT_ID: state.tenantId,
    AZURE_SUBSCRIPTION_ID: state.subscriptionId,
    AZURE_RESOURCE_GROUP: state.resourceGroup,
    AZURE_REGISTRY_NAME: state.registryName,
    AZURE_KEY_VAULT_NAME: state.vaultName,
    AZURE_STATIC_WEB_APP_NAME: state.dashboardName,
  };
}
