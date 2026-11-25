import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';

export const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

function executable(command, args) {
  if (process.platform === 'win32' && command.toLowerCase() === 'codex') {
    const shims = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true });
    for (const shim of (shims.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)) {
      const script = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(script)) return [process.execPath, [script, ...args]];
    }
    return ['codex.exe', args];
  }
  return [command, args];
}

export function run(command, args, { cwd, input, timeout = 60_000, env, raw = false } = {}) {
  const [file, argv] = executable(command, args);
  const result = spawnSync(file, argv, {
    cwd, input, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...env },
  });
  if (result.error || result.status !== 0) {
    const message = result.stderr?.toString().trim() || result.stdout?.toString().trim();
    throw new Error(command + ': ' + (result.error?.message || message || 'exit ' + result.status));
  }
  return raw ? result.stdout : result.stdout.toString().trim();
}

const gitOptions = [
  '-c', 'credential.helper=',
  '-c', 'credential.https://github.com.helper=!gh auth git-credential',
];

export function git(project, args, opts = {}) {
  return run('git', [...gitOptions, ...args], { cwd: project.gitRoot ?? project.root, ...opts });
}

export function gh(project, args, opts = {}) {
  return run('gh', args, { cwd: project.root, ...opts });
}

export function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const stage = join(dirname(path), '.' + basename(path) + '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(stage, content, { flag: 'wx' });
    renameSync(stage, path);
  } finally {
    rmSync(stage, { force: true });
  }
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function withLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 20_000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = fn();
    db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}

export function repositoryName(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)\/?$/i.exec(remote);
  const repo = match?.[1].replace(/\.git$/i, '');
  if (!repo || /\/\.{1,2}$|\/$/.test(repo)) throw new Error('Expected a GitHub repository URL.');
  return repo;
}

export function trustedRepoPath(path) {
  const parts = path.split('/');
  if (parts[0] !== 'wiki' || parts.length < 2 || parts.some((part) =>
    !part || /[\\:\x00-\x1f<>|?*"]|[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  )) throw new Error('Unsafe wiki path: ' + path);
  return parts;
}

export function isWithin(root, path) {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep));
}

export function localProject(cwd = process.cwd()) {
  const root = realpathSync(git({ root: cwd }, ['rev-parse', '--show-toplevel']));
  const local = join(root, '.superwiki');
  if (existsSync(local) && realpathSync(local) !== local) throw new Error('Expected a project-local .superwiki directory.');
  const localConfig = join(local, 'config.toml');
  const config = existsSync(localConfig) ? parse(readFileSync(localConfig, 'utf8')) : {};
  return { root, local, memory: join(local, 'memory'), state: join(local, 'state'), localConfig, config };
}

export function resolveWiki(local) {
  const remote = local.config.wiki?.remote;
  const project = { ...local };
  if (remote !== undefined) {
    project.repo = repositoryName(remote);
    project.gitRoot = join(local.local, 'wiki-git');
    if (!existsSync(join(project.gitRoot, '.git')) || realpathSync(project.gitRoot) !== project.gitRoot) {
      throw new Error('The Wiki checkout is missing or moved. Run project attach again.');
    }
    const mirrorRoot = git(project, ['rev-parse', '--show-toplevel']);
    const mirrorRemote = git(project, ['config', '--local', '--get', 'remote.origin.url']);
    if (realpathSync(mirrorRoot) !== project.gitRoot ||
        repositoryName(mirrorRemote).toLowerCase() !== project.repo.toLowerCase()) {
      throw new Error('The local Wiki checkout belongs to a different repository.');
    }
  } else {
    project.repo = repositoryName(git(project, ['remote', 'get-url', 'origin']));
  }
  let tracking;
  try {
    tracking = git(project, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  } catch {
    tracking = 'refs/remotes/origin/main';
  }
  const branch = tracking.slice('refs/remotes/origin/'.length);
  const shared = parse(git(project, ['show', tracking + ':superwiki.toml']));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(shared.project?.curator_login ?? '')) {
    throw new Error('Invalid project configuration on the GitHub default branch.');
  }
  project.branch = branch;
  project.curatorLogin = shared.project.curator_login;
  return project;
}

export function resolveProject(cwd = process.cwd()) {
  return resolveWiki(localProject(cwd));
}

export function saveConfig(project) {
  atomicWrite(project.localConfig, stringify(project.config));
}

function materialize(project, sha, destination) {
  const stage = mkdtempSync(join(dirname(destination), '.snapshot-'));
  try {
    const tree = git(project, ['ls-tree', '-rz', sha, '--', 'wiki'], { raw: true });
    const normalizedPaths = new Map();
    for (const entry of tree.toString().split('\0').filter(Boolean)) {
      const parts = /^(?:100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(entry);
      if (!parts) throw new Error('Wiki snapshots require regular Git files.');
      const [, ...relativePath] = trustedRepoPath(parts[2]);
      for (let depth = 1; depth <= relativePath.length; depth++) {
        const path = relativePath.slice(0, depth).join('/');
        const key = path.normalize('NFC').toLowerCase();
        const previous = normalizedPaths.get(key);
        if (previous && previous !== path) throw new Error('Colliding wiki paths: ' + previous + ', ' + path);
        normalizedPaths.set(key, path);
      }
      const content = git(project, ['cat-file', 'blob', parts[1]], { raw: true });
      atomicWrite(join(stage, ...relativePath), content);
    }
    if (!existsSync(join(stage, 'index.md'))) throw new Error('The default branch has no wiki/index.md.');
    renameSync(stage, destination);
  } finally {
    rmSync(stage, { force: true, recursive: true });
  }
}

export function syncWiki(project, { allowStale = false } = {}) {
  const index = join(project.state, 'wiki-current.json');
  return withLock(join(project.state, 'wiki-sync.lock'), () => {
    const folder = join(project.root, '.superwiki', 'wiki');
    let tracking;
    try {
      const head = git(project, ['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: 15_000 });
      const branch = /^ref: refs\/heads\/([^\r\n\t]+)\tHEAD$/m.exec(head)?.[1];
      if (!branch) throw new Error('GitHub did not report a default branch.');
      tracking = 'refs/remotes/origin/' + branch;
      git(project, ['fetch', '--no-tags', 'origin', '+refs/heads/' + branch + ':' + tracking], { timeout: 15_000 });
    } catch (error) {
      const current = readJson(index, null);
      const path = current && /^[a-f0-9]{40,64}$/.test(current.sha) && join(folder, current.sha);
      if (allowStale && path && existsSync(join(path, 'index.md'))) {
        return { ...current, path, stale: true };
      }
      throw error;
    }
    const sha = git(project, ['rev-parse', tracking]);
    const path = join(folder, sha);
    mkdirSync(folder, { recursive: true });
    if (!existsSync(path)) materialize(project, sha, path);
    git(project, ['symbolic-ref', 'refs/remotes/origin/HEAD', tracking]);
    const snapshot = { sha, syncedAt: new Date().toISOString() };
    atomicWrite(index, JSON.stringify(snapshot));
    return { ...snapshot, path, stale: false };
  });
}
