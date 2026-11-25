import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeMemory, captureTurn, memoryStart, memoryPrepare, memorySave, searchMemory } from '../src/memory.mjs';

function fixture(t, profile = 'codex') {
  const root = mkdtempSync(path.join(tmpdir(), 'superwiki-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    memory: path.join(root, '.superwiki', 'memory'),
    state: path.join(root, '.superwiki', 'state'),
    config: { member: { profile } },
  };
}

function prompt(project, turn, text, session = 'session-a') {
  return captureTurn(project, {
    hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: turn, prompt: text,
    transcript_path: 'native-transcript.jsonl',
  });
}

function reply(project, turn, text, session = 'session-a') {
  return captureTurn(project, {
    hook_event_name: 'Stop', session_id: session, turn_id: turn, last_assistant_message: text,
  });
}

test('captures one record per profile, session, turn, and role', t => {
  const project = fixture(t);
  initializeMemory(project);
  prompt(project, 'turn-1', 'First prompt');
  prompt(project, 'turn-1', 'Retry must preserve the first prompt');
  reply(project, 'turn-1', 'First response');
  reply(project, 'turn-1', 'Duplicate response');

  const file = path.join(project.memory, 'transcripts', 'codex', 'session-a.jsonl');
  const records = readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => [record.role, record.text]), [
    ['user', 'First prompt'], ['assistant', 'First response'],
  ]);
  assert.equal(records[0].transcriptPath, 'native-transcript.jsonl');
  assert.ok(Number.isFinite(Date.parse(records[0].capturedAt)));

  const secondProfile = { ...project, config: { member: { profile: 'other' } } };
  prompt(secondProfile, 'turn-1', 'Second profile');
  assert.match(readFileSync(path.join(project.memory, 'transcripts', 'other', 'session-a.jsonl'), 'utf8'), /Second profile/);
});

test('ignores events without a supported message', t => {
  const project = fixture(t);
  assert.equal(reply(project, 'turn-1', null).captured, false);
  const unknown = captureTurn(project, {
    hook_event_name: 'constructor', session_id: 'session-a', turn_id: 'turn-1', last_assistant_message: 'Ignore this',
  });
  assert.equal(unknown.captured, false);
  assert.equal(existsSync(path.join(project.memory, 'transcripts', 'codex', 'session-a.jsonl')), false);
});

test('stores unsafe profile and session IDs without escaping their directories', t => {
  const project = fixture(t, '..');
  prompt(project, 'turn-1', 'Safe content', '../../escape');
  const transcripts = path.join(project.memory, 'transcripts');
  const profiles = readdirSync(transcripts);
  assert.equal(profiles.length, 1);
  const files = readdirSync(path.join(transcripts, profiles[0]));
  assert.equal(files.length, 1);
  assert.match(readFileSync(path.join(transcripts, profiles[0], files[0]), 'utf8'), /Safe content/);
  assert.equal(existsSync(path.join(project.memory, 'escape.jsonl')), false);
});

test('limits preparation to the current task and adds a summary before Stop', t => {
  const project = fixture(t);
  prompt(project, 'before', 'Unrelated earlier prompt');
  reply(project, 'before', 'Unrelated earlier reply');
  prompt(project, 'start', 'Fix the native cache');
  const task = memoryStart(project, { session: 'session-a', turn: 'start', title: 'Build cache' });
  assert.equal(memoryStart(project, { session: 'session-a', turn: 'start' }).id, task.id);
  reply(project, 'start', 'Reproduced the cache issue');
  prompt(project, 'now', 'Verify the fix');
  prompt(project, 'elsewhere', 'Different session', 'session-b');
  reply(project, 'elsewhere', 'Different reply', 'session-b');
  const other = { ...project, config: { member: { profile: 'other' } } };
  prompt(other, 'foreign-profile', 'Different profile');
  reply(other, 'foreign-profile', 'Different reply');

  const summary = 'Verified the fixed build with a clean cache.';
  const prepared = memoryPrepare(project, { task: task.id, summary });
  assert.deepEqual(prepared.turns.map(turn => turn.turnId), ['start']);
  assert.deepEqual(prepared.pendingTurns.map(turn => turn.turnId), ['now']);
  assert.equal(prepared.summary, summary);
  assert.throws(() => memoryPrepare(other, { task: task.id, summary }), /profile/i);
  assert.equal(memoryPrepare(project, { task: task.id, summary }).inputVersion, prepared.inputVersion);
});

test('saves a searchable project note once and advances the task checkpoint', t => {
  const project = fixture(t);
  prompt(project, 'start', '构建缓存怎么清理？');
  const task = memoryStart(project, { session: 'session-a', turn: 'start', title: '构建缓存' });
  reply(project, 'start', '清理后重新构建。');
  const before = memoryPrepare(project, { task: task.id });
  const notes = [{ path: 'build-cache.md', text: '# 构建缓存\n\n删除损坏的缓存后重新构建。' }];
  const result = memorySave(project, { task: task.id, notes });
  assert.equal(result.inputVersion, before.inputVersion);
  assert.deepEqual(result.paths, ['.superwiki/memory/notes/build-cache.md']);
  assert.equal(memorySave(project, { task: task.id, notes }).duplicate, true);

  const other = { ...project, config: { member: { profile: 'other' } } };
  const hits = searchMemory(other, '怎样清理构建缓存');
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /删除损坏的缓存/);
  assert.match(readFileSync(path.join(project.memory, 'index.md'), 'utf8'), /notes\/build-cache\.md/);

  prompt(project, 'later', 'Check the release package');
  reply(project, 'later', 'Release package passed');
  const after = memoryPrepare(project, { task: task.id });
  assert.deepEqual(after.turns.map(turn => turn.turnId), ['later']);
  assert.notEqual(after.inputVersion, before.inputVersion);
  assert.equal(memorySave(project, { task: task.id, skip: true, complete: true }).complete, true);
});

test('supports generic summaries and imports with repeated checkpoints', t => {
  const project = fixture(t, 'generic');
  const task = memoryStart(project, { title: 'Generic task' });
  const summary = 'Verified that the build cache is portable.';
  const imported = 'Exported harness transcript';
  const prepared = memoryPrepare(project, { task: task.id, summary, imported });
  assert.deepEqual(prepared.turns, []);
  assert.equal(prepared.summary, summary);
  assert.equal(prepared.imported, imported);
  assert.equal(memorySave(project, { task: task.id, skip: true }).skipped, true);

  const repeated = memoryPrepare(project, { task: task.id, summary, imported });
  assert.equal(repeated.inputVersion, prepared.inputVersion);
  const saved = memorySave(project, { task: task.id, skip: true, complete: true });
  assert.equal(saved.duplicate, true);
  assert.equal(saved.complete, true);
});

test('validates all note paths before changing project memory', t => {
  const project = fixture(t);
  const task = memoryStart(project);
  memoryPrepare(project, { task: task.id, summary: 'Useful finding' });
  assert.throws(() => memorySave(project, { task: task.id, notes: [
    { path: 'valid.md', text: 'Valid note' },
    { path: '../escape.md', text: 'Unsafe path' },
  ] }), /path/i);
  assert.equal(existsSync(path.join(project.memory, 'notes', 'valid.md')), false);
  assert.equal(existsSync(path.join(project.memory, 'escape.md')), false);
  assert.equal(memorySave(project, { task: task.id, skip: true }).skipped, true);
});

test('rejects notes prepared against a superseded snapshot', t => {
  const project = fixture(t);
  const task = memoryStart(project);
  const before = memoryPrepare(project, { task: task.id, summary: 'Initial summary' });
  const after = memoryPrepare(project, { task: task.id, summary: 'Corrected summary' });
  assert.notEqual(before.inputVersion, after.inputVersion);
  assert.throws(() => memorySave(project, { task: task.id, notes: {
    inputVersion: before.inputVersion,
    notes: [{ path: 'stale.md', text: 'Stale summary' }],
  } }), /input version/i);
  assert.equal(existsSync(path.join(project.memory, 'notes', 'stale.md')), false);
});

test('resumes an interrupted note and index commit before recording progress', t => {
  const project = fixture(t);
  const task = memoryStart(project);
  const prepared = memoryPrepare(project, { task: task.id, summary: 'Recovery test' });
  const index = path.join(project.memory, 'index.md');
  rmSync(index);
  mkdirSync(index);
  const notes = [{ path: 'recovery.md', text: '# Recovery\n\nRetry an interrupted save.' }];
  assert.throws(() => memorySave(project, { task: task.id, notes }), /index\.md/);
  const taskFile = path.join(project.state, 'memory-tasks', `${task.id}.json`);
  const interrupted = JSON.parse(readFileSync(taskFile, 'utf8'));
  assert.equal(interrupted.lastSave, null);
  assert.equal(interrupted.prepared.inputVersion, prepared.inputVersion);
  rmSync(index, { recursive: true });
  const result = memorySave(project, { task: task.id, notes });
  assert.equal(result.inputVersion, prepared.inputVersion);
  assert.match(readFileSync(index, 'utf8'), /notes\/recovery\.md/);
  assert.equal(searchMemory(project, 'Recovery').length, 1);
});
