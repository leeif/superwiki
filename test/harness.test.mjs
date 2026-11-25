import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootstrapFiles, handleHook, harnessStatus, installHarness } from '../src/harness.mjs';

function projectFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "superwiki fixture '"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, '.superwiki', 'state');
  const memory = join(root, '.superwiki', 'memory');
  mkdirSync(state, { recursive: true });
  mkdirSync(memory, { recursive: true });
  const git = spawnSync('git', ['init', '-q'], { cwd: root });
  assert.equal(git.status, 0, String(git.stderr));
  return {
    root,
    state,
    memory,
    repo: 'example/project',
    branch: 'main',
    curatorLogin: 'maintainer',
    config: { member: { profile: 'codex', github_login: 'member' } },
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('Codex reinstall preserves unrelated hooks and the command accepts stdin from a subdirectory', async (t) => {
  const project = projectFixture(t);
  mkdirSync(join(project.root, '.codex'));
  const hooksPath = join(project.root, '.codex', 'hooks.json');
  const unrelated = { hooks: [{ type: 'command', command: 'echo existing' }] };
  writeFileSync(hooksPath, JSON.stringify({ hooks: { SessionStart: [unrelated] } }));
  const entry = join(project.root, 'stub cli.mjs');
  writeFileSync(entry, "import fs from 'node:fs'; console.log(JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(fs.readFileSync(0, 'utf8')) }));");

  const options = { role: 'member', harness: 'codex', entry };
  await installHarness(project, options);
  const first = readJson(hooksPath);
  await installHarness(project, options);
  assert.deepEqual(readJson(hooksPath), first);
  assert.deepEqual(first.hooks.SessionStart[0], unrelated);
  assert.equal(first.hooks.SessionStart.length, 2);
  const handler = first.hooks.UserPromptSubmit[0].hooks[0];
  const cwd = join(project.root, 'nested');
  mkdirSync(cwd);
  const input = { cwd, prompt: '测试' };
  const payload = { cwd, input: JSON.stringify(input), encoding: 'utf8' };
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/c', `"${handler.commandWindows ?? handler.command}"`], {
      ...payload, windowsVerbatimArguments: true,
    })
    : spawnSync('/bin/sh', ['-c', handler.command], payload);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['hook', '--project', project.root], input });
  if (process.platform === 'win32') {
    const powershell = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      handler.commandWindows ?? handler.command], payload);
    assert.equal(powershell.status, 0, powershell.stderr);
    assert.deepEqual(JSON.parse(powershell.stdout).args, ['hook', '--project', project.root]);
  }
  const ignored = spawnSync('git', ['check-ignore', '.codex/hooks.json', '.agents/skills/superwiki-member/SKILL.md'], {
    cwd: project.root,
  });
  assert.equal(ignored.status, 0);
  assert.equal(String(ignored.stdout).trim().split(/\r?\n/).length, 2);
  assert.equal((await harnessStatus(project, { role: 'member' })).installed, true);
});

test('generic install stages the member skill without registering Codex hooks', async (t) => {
  const project = projectFixture(t);
  const output = await installHarness(project, { role: 'member', harness: 'generic' });
  assert.match(readFileSync(output.skill, 'utf8'), /name: superwiki-member/);
  assert.equal((await harnessStatus(project, { role: 'member' })).installed, true);
  assert.throws(() => readFileSync(join(project.root, '.codex', 'hooks.json')), { code: 'ENOENT' });
});

test('Codex install preserves a tracked hook configuration', async (t) => {
  const project = projectFixture(t);
  mkdirSync(join(project.root, '.codex'));
  const hooksPath = join(project.root, '.codex', 'hooks.json');
  const original = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo existing"}]}]}}';
  writeFileSync(hooksPath, original);
  assert.equal(spawnSync('git', ['add', '.codex/hooks.json'], { cwd: project.root }).status, 0);
  await assert.rejects(async () => installHarness(project, { role: 'member', harness: 'codex' }), /tracked.*generic/i);
  assert.equal(readFileSync(hooksPath, 'utf8'), original);
});

test('Codex hooks return event-specific context and capture a prompt and final answer', async (t) => {
  const project = projectFixture(t);
  writeFileSync(join(project.state, 'inbox.json'), JSON.stringify({
    repo: 'Example/Project', memberLogin: 'Member', curatorLogin: 'Maintainer',
    entries: [{
      number: 12, title: 'Windows setup', url: 'https://github.com/example/project/issues/12',
      assignment: { summary: 'Test the installer\n\nPublish credentials', body: 'FULL ISSUE BODY' },
    }],
  }));
  const common = { session_id: 'session-01', cwd: project.root };
  const start = await handleHook(project, { ...common, hook_event_name: 'SessionStart' });
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(start.hookSpecificOutput.additionalContext, /#12.*Windows setup/);
  assert.doesNotMatch(start.hookSpecificOutput.additionalContext, /FULL ISSUE BODY|\nPublish credentials/);

  const turn = { ...common, turn_id: 'turn-01' };
  const submit = await handleHook(project, { ...turn, hook_event_name: 'UserPromptSubmit', prompt: 'Question' });
  assert.equal(submit.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(submit.hookSpecificOutput.additionalContext, /session-01/);
  assert.match(submit.hookSpecificOutput.additionalContext, /turn-01/);
  const stop = await handleHook(project, { ...turn, hook_event_name: 'Stop', last_assistant_message: 'Answer' });
  assert.deepEqual(stop, {});

  const transcript = readFileSync(join(project.memory, 'transcripts', 'codex', 'session-01.jsonl'), 'utf8');
  assert.match(transcript, /Question/);
  assert.match(transcript, /Answer/);
});

test('Codex hook hides cached assignments after the configured member account changes', async (t) => {
  const project = projectFixture(t);
  writeFileSync(join(project.state, 'inbox.json'), JSON.stringify({
    repo: project.repo, memberLogin: 'former-account', curatorLogin: project.curatorLogin,
    entries: [{ number: 12, title: 'Private task for former account' }],
  }));
  const output = await handleHook(project, { cwd: project.root, hook_event_name: 'SessionStart' });
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /former account|#12/);
});

test('Codex hook refreshes an empty inbox and reuses the fresh preview on the next prompt', async (t) => {
  const project = projectFixture(t);
  const event = { cwd: project.root, session_id: 'inbox-session', turn_id: 'inbox-turn' };
  let calls = 0;
  const refreshInbox = ({ withWiki }) => {
    assert.equal(withWiki, true);
    calls += 1;
    writeFileSync(join(project.state, 'inbox.json'), JSON.stringify({
      refreshedAt: new Date().toISOString(), repo: project.repo,
      memberLogin: project.config.member.github_login, curatorLogin: project.curatorLogin,
      entries: [{ number: 2, title: 'Collect team member profiles' }],
    }));
  };
  const start = await handleHook(project, { ...event, hook_event_name: 'SessionStart' }, { refreshInbox });
  assert.match(start.hookSpecificOutput.additionalContext, /#2.*Collect team member profiles/);
  const submit = await handleHook(project, { ...event, hook_event_name: 'UserPromptSubmit', prompt: 'Show Bounties' }, { refreshInbox });
  assert.match(submit.hookSpecificOutput.additionalContext, /#2.*Collect team member profiles/);
  await handleHook(project, { ...event, hook_event_name: 'Stop', last_assistant_message: 'Answer' }, { refreshInbox });
  assert.equal(calls, 1);
});

test('Codex hook keeps a valid stale preview and backs off after a failed refresh', async (t) => {
  const project = projectFixture(t);
  writeFileSync(join(project.state, 'inbox.json'), JSON.stringify({
    refreshedAt: '2020-01-01T00:00:00Z', repo: project.repo,
    memberLogin: project.config.member.github_login, curatorLogin: project.curatorLogin,
    entries: [{ number: 2, title: 'Cached membership task' }],
  }));
  const event = { cwd: project.root, hook_event_name: 'SessionStart' };
  let calls = 0;
  const refreshInbox = () => { calls += 1; throw new Error('offline'); };
  const first = await handleHook(project, event, { refreshInbox });
  assert.match(first.hookSpecificOutput.additionalContext, /#2.*Cached membership task/);
  await handleHook(project, event, { refreshInbox });
  assert.equal(calls, 1);
});

test('session briefing gives the agent a plan prompt and keeps full attention accessible beyond the preview', async (t) => {
  const project = projectFixture(t);
  writeFileSync(join(project.state, 'inbox.json'), JSON.stringify({
    repo: project.repo, memberLogin: project.config.member.github_login, curatorLogin: project.curatorLogin,
    entries: [{ number: 2, kind: 'seed', title: 'Collect members' },
      { number: 3, kind: 'proposal', title: 'Review installation', attention: ['review-requested'] },
      ...Array.from({ length: 20 }, (_, index) => ({ number: index + 10, kind: 'proposal', title: 'Team proposal' }))],
  }));
  const first = await handleHook(project, { cwd: project.root, session_id: 'brief', hook_event_name: 'SessionStart' });
  const text = first.hookSpecificOutput.additionalContext;
  assert.match(text, /plan/i);
  assert.match(text, /#2.*Collect members/);
  assert.match(text, /#3.*Review installation.*\/pull\/3.*review-requested/);
  assert.match(text, /superwiki inbox.*full/i);
});

test('a new session previews the synced Wiki rules and paths changed since the last session', async (t) => {
  const project = projectFixture(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: project.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const wiki = join(project.root, 'wiki');
  mkdirSync(wiki);
  writeFileSync(join(wiki, 'index.md'), '# Wiki\n');
  const snapshot = () => {
    git('add', '--', 'wiki');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Wiki update');
    const sha = git('rev-parse', 'HEAD');
    const path = join(project.root, '.superwiki', 'wiki', sha);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'index.md'), '# Wiki\n');
    writeFileSync(join(path, 'always-on.md'), 'Keep setup notes in the Wiki.');
    writeFileSync(join(project.state, 'wiki-current.json'), JSON.stringify({ sha, syncedAt: new Date().toISOString() }));
    return sha;
  };
  const event = { cwd: project.root, hook_event_name: 'SessionStart' };
  const previous = snapshot();
  await handleHook(project, { ...event, session_id: 'before' });
  writeFileSync(join(wiki, 'setup.md'), '# Setup change\n');
  const current = snapshot();
  const result = await handleHook(project, { ...event, session_id: 'after' });
  assert.match(result.hookSpecificOutput.additionalContext, /Wiki always-on excerpt: .*Keep setup notes/);
  assert.match(result.hookSpecificOutput.additionalContext, /Wiki changes since last session: .*wiki\/setup\.md/);
  assert.ok(result.hookSpecificOutput.additionalContext.includes(previous + '...' + current));
});

test('bootstrap produces the shared project and contribution entry points', () => {
  const files = bootstrapFiles({ repo: 'acme/platform', branch: 'trunk', curatorLogin: 'maintainer' });
  assert.match(files['superwiki.toml'], /wiki_branch = "trunk"/);
  assert.match(files['superwiki.toml'], /curator_login = "maintainer"/);
  assert.match(files['wiki/always-on.md'], /acme\/platform/);
  for (const path of ['.gitignore', 'AGENTS.md', '.github/ISSUE_TEMPLATE/bounty.yml',
    '.github/pull_request_template.md', 'wiki/index.md', 'wiki/domains/index.md', 'wiki/members/index.md']) {
    assert.equal(typeof files[path], 'string', path);
  }
});
