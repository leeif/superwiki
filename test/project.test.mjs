import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapBranch } from '../src/project.mjs';

test('an empty GitHub repository can report a blank default branch name', () => {
  assert.equal(bootstrapBranch({ defaultBranchRef: { name: '' } }), 'main');
  assert.equal(bootstrapBranch({ defaultBranchRef: { name: 'trunk' } }), 'trunk');
});
