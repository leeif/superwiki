import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { trustedRepoPath } from '../src/core.mjs';

const core = Symbol.for('superwiki.github.test.core');
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== './core.mjs' || !context.parentURL?.endsWith('/src/github.mjs')) {
      return nextResolve(specifier, context);
    }
    const exports = `const core = globalThis[Symbol.for('superwiki.github.test.core')];
      export const { ASSETS, gh, git, run, readJson, atomicWrite, withLock, syncWiki, resolveProject, trustedRepoPath } = core;`;
    return { url: `data:text/javascript,${encodeURIComponent(exports)}`, shortCircuit: true };
  },
});
const unconfigured = () => { throw new Error('Unexpected external command'); };
let fakeGh = unconfigured;
let fakeRun = unconfigured;
let fakeGit = unconfigured;
let fakeSyncWiki = unconfigured;
let fakeResolveProject = unconfigured;
const fixtures = mkdtempSync(join(tmpdir(), 'superwiki-github-test-'));
const skill = join(fixtures, 'skills', 'superwiki-curator', 'SKILL.md');
mkdirSync(dirname(skill), { recursive: true });
writeFileSync(skill, 'Use the structured output.');
globalThis[core] = {
  ASSETS: fixtures,
  gh: (...args) => fakeGh(...args),
  run: (...args) => fakeRun(...args),
  git: (...args) => fakeGit(...args),
  syncWiki: (...args) => fakeSyncWiki(...args),
  resolveProject: (...args) => fakeResolveProject(...args),
  trustedRepoPath,
  atomicWrite(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  },
  readJson(path, fallback) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  },
  withLock(_path, fn) { return fn(); },
};
const { bountyCreate, getInboxItem, inboxList, inboxTake, listWikiProposals, proposalCreate, runCurator } = await import('../src/github.mjs');
hooks.deregister();
test.after(() => rmSync(fixtures, { recursive: true, force: true }));

function setup(t) {
  const root = mkdtempSync(join(fixtures, 'project-'));
  const project = { root, state: join(root, '.superwiki', 'state'), repo: 'acme/wiki', branch: 'main',
    curatorLogin: 'curator', config: { member: { github_login: 'mei' } } };
  fakeResolveProject = () => project;
  t.after(() => {
    fakeGh = unconfigured;
    fakeRun = unconfigured;
    fakeGit = unconfigured;
    fakeSyncWiki = unconfigured;
    fakeResolveProject = unconfigured;
  });
  return project;
}

const endpoint = 'repos/acme/wiki/issues';
const digest = '0123456789abcdef0123456789abcdef';

function issue(number, fields = {}) {
  return { number, title: `Bounty ${number}`, state: 'open', body: 'What is the build command?',
    html_url: `https://github.com/acme/wiki/issues/${number}`, user: { login: 'author' },
    author_association: 'MEMBER', assignees: [], labels: [{ name: 'sw:bounty' }], ...fields };
}

function comment(id, login, body) {
  return { id, user: { login }, body, author_association: 'MEMBER',
    html_url: `https://github.com/acme/wiki/issues/12#issuecomment-${id}` };
}

function api(args) {
  assert.equal(args[0], 'api');
  return [args[1], args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'];
}

test('a closed startup Bounty satisfies a retry without publishing another issue', t => {
  const project = setup(t);
  fakeGh = (_, args) => {
    const [path, method] = api(args);
    assert.equal(method, 'GET');
    if (path === 'user') return JSON.stringify({ login: 'curator' });
    assert.match(path, /state=all/);
    return JSON.stringify([[issue(12, { state: 'closed', user: { login: 'curator' },
      body: 'Question\n\n<!-- superwiki:seed project-context -->' })]]);
  };
  const result = bountyCreate(project, { seed: 'project-context', title: 'Question', body: 'Question' });
  assert.equal(result.number, 12);
  assert.equal(result.state, 'closed');
});

test('inbox requires both the GitHub assignee and an authenticated Curator dispatch author', t => {
  const project = setup(t);
  const body = `@mei Please document the verified setup.\n\n<!-- superwiki:dispatch ${digest} mei -->`;
  const issues = [
    issue(10, { assignees: [{ login: 'MEI' }] }),
    issue(11, { assignees: [{ login: 'mei' }] }),
    issue(12, { assignees: [{ login: 'someone' }] }),
    issue(13, { user: { login: 'curator' }, body: 'Startup\n\n<!-- superwiki:seed member-directory -->' }),
  ];
  fakeGh = (_, args) => {
    const [path, method] = api(args);
    assert.equal(method, 'GET');
    if (path.includes('?')) return JSON.stringify([issues]);
    const number = Number(path.split('/').at(-2));
    return JSON.stringify([[comment(number, number === 11 ? 'imposter' : 'CURATOR', body)]]);
  };
  const entries = inboxList(project);
  assert.deepEqual(entries.map(({ number, kind }) => [number, kind]), [[10, 'dispatch'], [13, 'seed']]);
  assert.equal(entries[0].assignment.summary, '@mei Please document the verified setup.');
});

test('taking the same dispatch again reuses the member acknowledgment', t => {
  const project = setup(t);
  const comments = [comment(1, 'curator', `@mei Verify.\n\n<!-- superwiki:dispatch ${digest} mei -->`)];
  let acknowledgments = 0;
  fakeGh = (_, args, { input } = {}) => {
    const [path, method] = api(args);
    if (path === 'user') return JSON.stringify({ login: 'mei' });
    if (path === `${endpoint}/12`) return JSON.stringify(issue(12, { assignees: [{ login: 'mei' }] }));
    assert.match(path, /\/12\/comments/);
    if (method === 'GET') return JSON.stringify([comments]);
    assert.equal(method, 'POST');
    const entry = comment(2, 'mei', JSON.parse(input).body);
    acknowledgments += 1;
    comments.push(entry);
    return JSON.stringify(entry);
  };
  const first = inboxTake(project, 12);
  const second = inboxTake(project, 12);
  assert.equal(first.url, second.url);
  assert.equal(acknowledgments, 1);
});

test('open Wiki proposals include the member’s review requests, own changes and team context', t => {
  const project = setup(t);
  fakeGh = (_, args) => {
    assert.deepEqual(args.slice(0, 9), ['pr', 'list', '--repo', 'acme/wiki', '--state', 'open', '--label', 'sw:proposal', '--limit']);
    return JSON.stringify([
      { number: 21, title: 'Team proposal', author: { login: 'someone' }, assignees: [] },
      { number: 22, title: 'Please review', author: { login: 'someone' }, reviewRequests: [{ login: 'MEI' }] },
      { number: 23, title: 'My draft', author: { login: 'mei' }, isDraft: true, reviewDecision: 'CHANGES_REQUESTED' },
      { number: 24, title: 'Assigned to me', assignees: [{ login: 'mei' }] },
    ]);
  };
  assert.deepEqual(listWikiProposals(project).map(({ number, kind, attention }) => [number, kind, attention]), [
    [21, 'proposal', ['team']], [22, 'proposal', ['review-requested']],
    [23, 'proposal', ['author']], [24, 'proposal', ['assigned']],
  ]);
});

test('inbox show resolves both a Bounty and a Wiki proposal by GitHub number', t => {
  const project = setup(t);
  fakeGh = (_, args) => {
    const [path] = api(args);
    if (path === `${endpoint}/2`) return JSON.stringify(issue(2));
    if (path === `${endpoint}/3`) return JSON.stringify({ ...issue(3), pull_request: {} });
    if (path === 'repos/acme/wiki/pulls/3') return JSON.stringify({ ...issue(3, { labels: [{ name: 'sw:proposal' }] }),
      head: { sha: 'head' }, base: { ref: 'main' }, draft: false });
    if (path === 'repos/acme/wiki/pulls/3/files') return JSON.stringify([[{ filename: 'wiki/index.md', status: 'modified' }]]);
    assert.match(path, /\/comments$/);
    return JSON.stringify([[]]);
  };
  assert.equal(getInboxItem(project, 2).number, 2);
  const pull = getInboxItem(project, 3);
  assert.equal(pull.kind, 'proposal');
  assert.equal(pull.files[0].path, 'wiki/index.md');
});

test('proposal validation rejects a path outside the wiki before external side effects', t => {
  const project = setup(t);
  assert.throws(() => proposalCreate(project, { title: 'Outside', body: 'Evidence',
    changes: { 'wiki/../.github/workflows/unsafe.md': 'body' } }), /wiki.*path|path.*wiki/i);
});

test('retrying a Proposal reuses its pushed worktree commit and repairs a missing label', t => {
  const project = setup(t);
  const bare = mkdtempSync(join(fixtures, 'remote-'));
  const git = (args, cwd = project.root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--bare', '-b', 'main', bare]);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test author']);
  git(['config', 'user.email', 'test@example.com']);
  git(['remote', 'add', 'origin', bare]);
  mkdirSync(join(project.root, 'wiki'));
  writeFileSync(join(project.root, 'wiki', 'index.md'), '# Index\n');
  git(['add', 'wiki']);
  git(['commit', '-m', 'Seed main']);
  git(['push', 'origin', 'main']);
  const originalSha = git(['rev-parse', 'HEAD']);
  let sha = originalSha;
  git(['switch', '-c', 'member-work']);
  writeFileSync(join(project.root, 'wiki', 'index.md'), '# Dirty local edit\n');

  fakeSyncWiki = () => ({ sha, path: join(project.root, 'wiki') });
  fakeGit = (_, args, opts) => git(args, opts?.cwd);
  let proposal;
  let publishedHead;
  let created = 0;
  let labelsAttempted = 0;
  fakeGh = (_, args, { input } = {}) => {
    const [path, method] = api(args);
    if (path.startsWith('repos/acme/wiki/pulls?')) return JSON.stringify([proposal ? [proposal] : []]);
    if (path === 'repos/acme/wiki/pulls' && method === 'POST') {
      const pr = JSON.parse(input);
      publishedHead ??= pr.head;
      assert.equal(pr.head, publishedHead);
      assert.equal(pr.base, 'main');
      assert.equal(pr.draft, true);
      assert.match(pr.body, /Closes #12/);
      if (++created === 1) throw new Error('Temporary create failure');
      proposal = { ...issue(13, { labels: [] }), ...pr };
      return JSON.stringify(proposal);
    }
    assert.equal(path, `${endpoint}/13/labels`);
    assert.equal(method, 'POST');
    if (++labelsAttempted === 1) throw new Error('Temporary label failure');
    proposal.labels = JSON.parse(input).labels.map(name => ({ name }));
    return JSON.stringify(proposal.labels);
  };
  const options = { title: 'Document setup', body: 'Verified with the build.', closes: 12,
    changes: { 'wiki/index.md': '# Published index\n' } };
  assert.throws(() => proposalCreate(project, options), /Temporary create failure/);
  const ref = git(['ls-remote', '--heads', 'origin', 'superwiki/*']).split(/\s/)[1];
  const published = git(['rev-parse', ref], bare);
  const upstream = join(fixtures, 'upstream');
  git(['worktree', 'add', upstream, 'main']);
  writeFileSync(join(upstream, 'unrelated.txt'), 'New content on the default branch\n');
  git(['add', 'unrelated.txt'], upstream);
  git(['commit', '-m', 'Advance main'], upstream);
  git(['push', 'origin', 'main'], upstream);
  sha = git(['rev-parse', 'HEAD'], upstream);
  git(['worktree', 'remove', upstream]);
  assert.throws(() => proposalCreate(project, options), /Temporary label failure/);
  const result = proposalCreate(project, options);
  assert.deepEqual(result.labels.map(label => label.name), ['sw:proposal']);
  assert.equal(result.number, 13);
  assert.equal(git(['rev-parse', ref], bare), published);
  assert.equal(git(['rev-parse', `${published}^`], bare), originalSha);
  assert.equal(git(['diff-tree', '--no-commit-id', '--name-only', '-r', published], bare), 'wiki/index.md');
  assert.equal(git(['show', `${published}:wiki/index.md`], bare), '# Published index');
  assert.equal(git(['branch', '--show-current']), 'member-work');
  assert.equal(readFileSync(join(project.root, 'wiki', 'index.md'), 'utf8'), '# Dirty local edit\n');
  assert.equal(git(['worktree', 'list', '--porcelain']).split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 1);
  proposal.state = 'closed';
  assert.equal(proposalCreate(project, options).state, 'closed');
  assert.equal(created, 2);
});

test('Curator resumes a dispatch after the comment request fails without regenerating its decision', t => {
  const project = setup(t);
  const wiki = join(project.root, 'wiki');
  mkdirSync(wiki);
  fakeSyncWiki = () => ({ sha: 'abc123', path: wiki });
  const comments = [];
  const assignees = [];
  let inferences = 0;
  let commentsAttempted = 0;
  let actorLogin = 'curator';
  fakeRun = (_, args) => {
    inferences += 1;
    const output = args[args.indexOf('-o') + 1];
    writeFileSync(output, JSON.stringify({ action: 'assign', body: 'Verify the build.',
      assignee: 'mei', title: '', changes: [], closes: false }));
    return '';
  };
  fakeGh = (_, args, { input } = {}) => {
    const [path, method] = api(args);
    if (path === 'user') return JSON.stringify({ login: actorLogin });
    if (path === `${endpoint}/12`) return JSON.stringify(issue(12, { assignees }));
    if (path.endsWith('/assignees/mei')) return '';
    if (path === `${endpoint}/12/assignees` && method === 'POST') {
      assignees.push(...JSON.parse(input).assignees.map(login => ({ login })));
      return JSON.stringify(issue(12, { assignees }));
    }
    assert.match(path, /\/12\/comments/);
    if (method === 'GET') return JSON.stringify([comments]);
    assert.equal(method, 'POST');
    if (++commentsAttempted === 1) throw new Error('Temporary comment failure');
    const entry = comment(comments.length + 1, actorLogin, JSON.parse(input).body);
    comments.push(entry);
    return JSON.stringify(entry);
  };
  const preview = runCurator(project, { issue: 12, dryRun: true });
  assert.equal(preview.results[0].action, 'assign');
  assert.equal(assignees.length, 0);
  assert.equal(commentsAttempted, 0);
  assert.equal(runCurator(project, { issue: 12 }).failures.length, 1);
  let refreshes = 0;
  fakeResolveProject = () => ++refreshes === 1 ? project : { ...project, curatorLogin: 'new-curator' };
  const switched = runCurator(project, { issue: 12 });
  assert.match(switched.failures[0]?.error, /Curator.*changed|authenticate.*new-curator/i);
  assert.equal(commentsAttempted, 1);
  fakeResolveProject = () => project;
  assert.equal(runCurator(project, { issue: 12 }).failures.length, 0);
  assert.equal(runCurator(project, { issue: 12 }).failures.length, 0);
  assert.equal(inferences, 2);
  assert.equal(assignees.length, 1);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /@mei\b/);
  comments.push(comment(2, 'curator', 'I verified the build myself.'));
  assert.equal(runCurator(project, { issue: 12 }).failures.length, 0);
  assert.equal(inferences, 3);
  const dispatchFooter = comments.at(-1).body.split('\n').at(-1);
  actorLogin = 'new-curator';
  fakeResolveProject = () => ({ ...project, curatorLogin: actorLogin });
  const rotated = runCurator(project, { issue: 12 });
  assert.equal(rotated.results[0]?.action, 'assign');
  assert.equal(comments.at(-1).user.login, 'new-curator');
  assert.equal(comments.at(-1).body.split('\n').at(-1), dispatchFooter);
  assert.equal(inferences, 4);
});

test('Curator reviews each Proposal head once and supplies linked Bounty evidence', t => {
  const project = setup(t);
  const wiki = join(project.root, 'wiki');
  mkdirSync(wiki);
  fakeSyncWiki = () => ({ sha: 'abc123', path: wiki });
  const reviews = [];
  let head = 'commit-1';
  let inferences = 0;
  fakeRun = (_, args, { input }) => {
    inferences += 1;
    const supplied = JSON.parse(input.split('\n').at(-1));
    assert.equal(supplied.proposal.headSha, head);
    assert.equal(supplied.files[0].path, 'wiki/index.md');
    assert.equal(supplied.relatedBounties[0].bounty.number, 12);
    assert.equal(supplied.relatedBounties[0].replies[0].body, 'Verified with npm test.');
    writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ action: 'review', body: 'Add the command version.',
      assignee: '', title: '', changes: [], closes: false }));
    return '';
  };
  fakeGh = (_, args, { input } = {}) => {
    const [path, method] = api(args);
    if (path === 'user') return JSON.stringify({ login: 'curator' });
    if (path === 'repos/acme/wiki/pulls/13') return JSON.stringify({
      ...issue(13, { body: 'Closes #12', labels: [{ name: 'sw:proposal' }] }), head: { sha: head },
      base: { ref: 'main' }, draft: true,
    });
    if (path === 'repos/acme/wiki/pulls/13/files') return JSON.stringify([[{ filename: 'wiki/index.md', patch: '+help' }]]);
    if (path === `${endpoint}/12`) return JSON.stringify(issue(12));
    if (path === `${endpoint}/12/comments`) return JSON.stringify([[comment(2, 'mei', 'Verified with npm test.')]]);
    assert.equal(path, `${endpoint}/13/comments`);
    if (method === 'GET') return JSON.stringify([reviews]);
    const entry = comment(reviews.length + 10, 'curator', JSON.parse(input).body);
    reviews.push(entry);
    return JSON.stringify(entry);
  };
  assert.deepEqual(runCurator(project, { pr: 13 }).failures, []);
  assert.deepEqual(runCurator(project, { pr: 13 }).failures, []);
  assert.equal(inferences, 1);
  head = 'commit-2';
  assert.deepEqual(runCurator(project, { pr: 13 }).failures, []);
  assert.equal(inferences, 2);
  assert.equal(reviews.length, 2);
});
