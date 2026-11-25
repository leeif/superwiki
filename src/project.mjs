import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, gh, git, localProject, repositoryName, resolveProject, resolveWiki, run, saveConfig, syncWiki, withLock } from './core.mjs';
import { bootstrapFiles, excludeLocalFiles, harnessStatus, installHarness } from './harness.mjs';
import { bountyCreate, ensureLabels, inboxList, listWikiProposals } from './github.mjs';
import { initializeMemory, searchMemory } from './memory.mjs';

const entry = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const roleNames = new Set(['member', 'curator']);
const harnessNames = new Set(['codex', 'generic']);

export const seedBounties = {
  'project-context': {
    title: '收集项目背景和初始化信息',
    body: '请分享你能确认的项目目的、目录入口、启动步骤、常用命令和团队约定。附上可共享的来源或验证结果。\n\n可以在这里分批回复或开使用 Refs 关联本 Issue 的草稿 PR。汇总完成时再关闭。',
  },
  'member-directory': {
    title: '收集团队成员信息',
    body: '请成员本人确认后分享 GitHub 登录名、擅长领域、愿意接的任务、可以协审的范围和工作偏好。若愿意分享，可注明当前 review 或 merge 职责，由维护者核对权限。\n\n可以在这里分批回复或开使用 Refs 关联本 Issue 的草稿 PR。',
  },
};

function activeLogin(project) {
  return gh(project, ['api', 'user', '--jq', '.login']);
}

function guestRepository(cwd, repo) {
  return JSON.parse(gh({ root: cwd }, ['repo', 'view', repo, '--json',
    'nameWithOwner,isEmpty,defaultBranchRef,viewerPermission,hasIssuesEnabled']));
}

export function bootstrapBranch(details) {
  return details.defaultBranchRef?.name || 'main';
}

function hasCommitIdentity(project) {
  try {
    git(project, ['var', 'GIT_AUTHOR_IDENT']);
    git(project, ['var', 'GIT_COMMITTER_IDENT']);
    return true;
  } catch {
    return false;
  }
}

function bootstrapEmpty(project, branch, author) {
  if (!hasCommitIdentity(project)) throw new Error('Configure your Git user.name and user.email before creating commits.');
  const files = bootstrapFiles({ repo: project.repo, branch, curatorLogin: author });
  let head = false;
  try {
    git(project, ['rev-parse', '--verify', 'HEAD']);
    head = true;
  } catch {
    // An empty clone has an unborn branch.
  }
  if (head) {
    const subjects = git(project, ['log', '--format=%s']);
    if (subjects !== 'Initialize SuperWiki project') {
      throw new Error('Found existing local commits in the empty GitHub project checkout.');
    }
    for (const name of Object.keys(files)) git(project, ['cat-file', '-e', 'HEAD:' + name]);
  } else {
    git(project, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]);
    for (const [name, text] of Object.entries(files)) {
      const file = join(project.root, name);
      if (existsSync(file) && readFileSync(file, 'utf8') !== text) {
        throw new Error('Bootstrap file already exists with different content: ' + name);
      }
      if (!existsSync(file)) atomicWrite(file, text);
    }
    git(project, ['add', '--', ...Object.keys(files)]);
    git(project, ['commit', '--only', '-m', 'Initialize SuperWiki project', '--', ...Object.keys(files)]);
  }
  git(project, ['push', '-u', 'origin', 'HEAD:refs/heads/' + branch]);
  git(project, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + branch]);
}

export async function initializeProject({ remote, path, harness = 'codex', seed }) {
  if (!harnessNames.has(harness)) throw new Error('Choose codex or generic as the harness.');
  const name = repositoryName(remote);
  const details = guestRepository(process.cwd(), name);
  if (!details.hasIssuesEnabled) throw new Error('Enable Issues on the GitHub repository first.');
  const root = resolve(path);
  const project = { root, repo: details.nameWithOwner };
  if (!existsSync(root) || readdirSync(root).length === 0) {
    mkdirSync(dirname(root), { recursive: true });
    git({ root: dirname(root) }, ['clone', '--', 'https://github.com/' + project.repo + '.git', root]);
  }
  const localRoot = git(project, ['rev-parse', '--show-toplevel']);
  if (realpathSync(localRoot) !== realpathSync(root) ||
      repositoryName(git(project, ['remote', 'get-url', 'origin'])).toLowerCase() !== name.toLowerCase()) {
    throw new Error('The target folder already belongs to a different project. Use project attach --remote URL from that project to bind its Wiki.');
  }
  if (details.isEmpty) bootstrapEmpty(project, bootstrapBranch(details), activeLogin(project));
  else git(project, ['fetch', '--no-tags', 'origin']);
  const configured = resolveProject(root);
  const installed = installRole(configured, { role: 'member', harness });
  const wiki = syncWiki(configured);
  const bounties = [];
  await ensureLabels(configured);
  if (seed) {
    for (const [key, details] of Object.entries(seedBounties)) {
      bounties.push(await bountyCreate(configured, { ...details, seed: key }));
    }
  }
  return { repo: configured.repo, path: root, branch: configured.branch, wiki, installed, bounties };
}

export function attachProject({ remote, harness = 'codex' }) {
  if (!harnessNames.has(harness)) throw new Error('Choose codex or generic as the harness.');
  const local = localProject();
  const details = guestRepository(local.root, repositoryName(remote));
  if (details.isEmpty) throw new Error('Initialize the empty Wiki repository before attaching a local project.');
  const target = details.nameWithOwner;
  if (git(local, ['ls-files', '--', '.superwiki/'])) throw new Error('The local .superwiki directory must be excluded from source control.');
  excludeLocalFiles(local, ['/.superwiki/']);

  return withLock(join(local.state, 'attach.lock'), () => {
    const project = localProject(local.root);
    const existing = project.config.wiki?.remote;
    const configured = existing || ((project.config.member || project.config.curator) && git(project, ['remote', 'get-url', 'origin']));
    if (configured && repositoryName(configured).toLowerCase() !== target.toLowerCase()) {
      throw new Error('This checkout is already bound to ' + repositoryName(configured) + '.');
    }
    const wikiRemote = 'https://github.com/' + target + '.git';
    const mirror = join(project.local, 'wiki-git');
    if (!existsSync(mirror)) git(project, ['clone', '--no-checkout', '--', wikiRemote, mirror]);
    project.config.wiki = { ...project.config.wiki, remote: wikiRemote };
    const bound = resolveWiki(project);
    const wiki = syncWiki(bound);
    const current = resolveWiki(bound);
    const installed = installRole(current, { role: 'member', harness });
    return { repo: current.repo, path: current.root, branch: current.branch, wiki, installed };
  });
}

export function installRole(project, { role = 'member', harness = 'codex' } = {}) {
  if (!roleNames.has(role) || !harnessNames.has(harness) || (role === 'curator' && harness !== 'codex')) {
    throw new Error('Choose member with codex or generic, or curator with codex.');
  }
  const login = activeLogin(project);
  if (role === 'curator' && login.toLowerCase() !== project.curatorLogin.toLowerCase()) {
    throw new Error('GitHub CLI is signed in as a different user than project.curator_login.');
  }
  if (role === 'member') {
    project.config.member = { poll_seconds: 15, ...project.config.member, github_login: login, harness,
      profile: project.config.member?.profile ?? harness };
    initializeMemory(project);
  } else {
    project.config.curator = { codex_command: 'codex', fallback_assignee: login, poll_seconds: 15,
      timeout_seconds: 120, ...project.config.curator, harness };
  }
  const installed = installHarness(project, { role, harness, entry });
  saveConfig(project);
  return installed;
}

export function doctor(project, role = 'member') {
  if (!roleNames.has(role)) throw new Error('Choose member or curator as the role.');
  const status = harnessStatus(project, { role });
  const login = activeLogin(project);
  const details = guestRepository(project.root, project.repo);
  const identityMatches = role === 'curator'
    ? login.toLowerCase() === project.curatorLogin.toLowerCase()
    : login.toLowerCase() === project.config.member?.github_login?.toLowerCase();
  const canWrite = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(details.viewerPermission);
  let codex = null;
  if (status.harness === 'codex' || role === 'curator') {
    const executable = project.config.curator?.codex_command ?? 'codex';
    run(executable, ['login', 'status'], { cwd: project.root });
    codex = { loggedIn: true, version: run(executable, ['--version'], { cwd: project.root }) };
  }
  const memory = role !== 'member' || existsSync(join(project.memory, 'index.md'));
  const gitIdentity = hasCommitIdentity(project);
  const ok = status.installed && identityMatches && canWrite && details.hasIssuesEnabled && memory && gitIdentity;
  return { ok, repo: project.repo, role, login, identityMatches, canWrite, memory, gitIdentity, codex, ...status };
}

function wikiFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return wikiFiles(child);
    return entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}

export function context(project, query = '', { searchOnly = false } = {}) {
  const wiki = syncWiki(project, { allowStale: true });
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query.toLowerCase())]
    .filter((part) => part.isWordLike).map((part) => part.segment);
  const required = ['always-on.md', 'index.md'];
  const docs = wikiFiles(wiki.path).map((path) => {
    const name = relative(wiki.path, path).replaceAll('\\', '/');
    const text = readFileSync(path, 'utf8');
    const haystack = (name + '\n' + text).toLowerCase();
    const score = words.filter((word) => haystack.includes(word)).length;
    return { path, name, text: text.slice(0, 8_000), score, source: 'team-wiki' };
  });
  const team = docs.filter((doc) => doc.score && (searchOnly || !required.includes(doc.name)))
    .sort((a, b) => b.score - a.score).slice(0, 6);
  const essentials = searchOnly ? [] : required.flatMap((name) => docs.filter((doc) => doc.name === name));
  const local = query ? searchMemory(project, query, 6) : [];
  return { wiki, documents: [...essentials, ...team], memory: local, query };
}

export function refreshInbox(project) {
  if (!project.config.member?.github_login) throw new Error('Install the member role in this project first.');
  const bounties = inboxList(project);
  const proposals = listWikiProposals(project);
  const directlyRelevant = ({ attention }) => attention.some(reason => ['review-requested', 'assigned', 'author'].includes(reason));
  const entries = [
    ...bounties.filter(entry => entry.kind === 'dispatch'),
    ...proposals.filter(directlyRelevant),
    ...bounties.filter(entry => entry.kind !== 'dispatch'),
    ...proposals.filter(entry => !directlyRelevant(entry)),
  ];
  const refreshedAt = new Date().toISOString();
  atomicWrite(join(project.state, 'inbox.json'), JSON.stringify({
    refreshedAt, repo: project.repo, memberLogin: project.config.member.github_login,
    curatorLogin: project.curatorLogin, entries,
  }));
  return entries;
}

export function refreshBrief(project) {
  const entries = refreshInbox(project);
  const wiki = syncWiki(project, { allowStale: true });
  return { entries, wiki };
}

export function refreshMember(project) {
  if (!project.config.member?.github_login) throw new Error('Install the member role in this project first.');
  const wiki = syncWiki(project);
  return { wiki, entries: refreshInbox(resolveProject(project.root)) };
}
