import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });

test('CLI help exposes the project, member, memory and curator workflows without GitHub access', () => {
  const result = cli('--help');
  assert.equal(result.status, 0, result.stderr);
  for (const command of ['project init', 'project attach --remote URL', 'member run', 'memory prepare', 'curator run-once', 'inbox']) {
    assert.ok(result.stdout.includes(command), command);
  }
});

test('CLI refuses an unexpected command before project discovery', () => {
  const result = cli('unknown');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command/i);
});

test('a project hook ignores messages from a nested independent repository', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'superwiki-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inner = join(root, 'inner');
  assert.equal(spawnSync('git', ['init', inner]).status, 0);
  const result = spawnSync(process.execPath, [entry, 'hook', '--project', root], {
    input: JSON.stringify({ cwd: inner, hook_event_name: 'UserPromptSubmit', prompt: 'nested project' }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});
