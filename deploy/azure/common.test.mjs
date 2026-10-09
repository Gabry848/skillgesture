import assert from 'node:assert/strict';
import test from 'node:test';
import { githubMainSubject } from './common.mjs';

test('federation follows immutable GitHub repository IDs and stays scoped to main', () => {
  assert.equal(githubMainSubject('gabry848/skillgesture', {
    use_default: true, use_immutable_subject: true,
    sub_claim_prefix: 'repo:gabry848@118192073/skillgesture@1356142263',
  }), 'repo:gabry848@118192073/skillgesture@1356142263:ref:refs/heads/main');
});
test('legacy repositories retain their default main subject', () => {
  assert.equal(githubMainSubject('owner/repo', { use_default: true }), 'repo:owner/repo:ref:refs/heads/main');
});
test('federation refuses ambiguous or unrelated subject templates', () => {
  for (const configuration of [
    { use_default: false },
    { use_default: true, use_immutable_subject: true },
    { use_default: true, sub_claim_prefix: 'repo:other@1/repo@2' },
    { use_default: true, sub_claim_prefix: 'repo:owner/repo:environment:production' },
  ]) assert.throws(() => githubMainSubject('owner/repo', configuration));
});
