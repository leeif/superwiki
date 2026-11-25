#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { git, isWithin, resolveProject, run, trustedRepoPath } from './core.mjs';

const commands = Object.freeze({
  'project init': '--remote URL --path DIR [--harness codex|generic] [--seed-bounties]',
  'project attach': '--remote URL [--harness codex|generic]',
  install: '--role member|curator [--harness codex|generic]',
  doctor: '--role member|curator',
  context: '[--query TEXT]',
  search: 'TEXT',
  'member run': '[--once]',
  'memory start': '[--title TEXT] [--session ID --turn ID]',
  'memory prepare': '--task ID [--summary-file FILE] [--import-file FILE]',
  'memory save': '--task ID (--file JSON | --skip) [--complete]',
  'bounty create': '[--title TEXT --body-file FILE | --seed project-context|member-directory]',
  'bounty list': '',
  'proposal create': '(--path wiki/PAGE.md --file FILE | --changes-dir DIR) --body-file FILE [--title TEXT] [--closes NUMBER]',
  inbox: '[--with-wiki]',
  'inbox show': 'NUMBER',
  'inbox take': 'NUMBER',
  'inbox reply': 'NUMBER --body-file FILE',
  'curator run': '',
  'curator run-once': '[--issue NUMBER | --pr NUMBER] [--dry-run]',
  hook: '--project DIR',
});

function help() {
  console.log('SuperWiki\n\n' + Object.entries(commands)
    .map(([command, options]) => '  superwiki ' + command + (options ? ' ' + options : '')).join('\n'));
}

function options(args, strings = [], booleans = [], count = 0) {
  const definition = {};
  for (const flag of strings) definition[flag] = { type: 'string' };
  for (const flag of booleans) definition[flag] = { type: 'boolean' };
  const { values, positionals } = parseArgs({ args, options: definition, allowPositionals: count > 0 });
  if (positionals.length !== count) throw new Error('Expected ' + count + ' positional argument(s).');
  return { values, positionals };
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Supply ' + name + '.');
  return value;
}

function number(value) {
  if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
    throw new Error('Expected a positive GitHub issue or PR number.');
  }
  return Number(value);
}

function read(path, name) {
  return readFileSync(required(path, name), 'utf8').replace(/^\uFEFF/, '');
}

function heading(text) {
  const first = text.trim().split(/\r?\n/)[0]?.replace(/^#+\s*/, '').trim();
  if (!first) throw new Error('Supply a title or a nonempty file.');
  return first.slice(0, 120);
}

function collectChanges(path, folder = 'wiki') {
  const files = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const name = folder + '/' + entry.name;
    trustedRepoPath(name);
    const local = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(files, collectChanges(local, name));
    else if (entry.isFile() && entry.name.endsWith('.md')) files[name] = read(local, '--changes-dir');
    else throw new Error('Proposal changes must be Markdown files: ' + name);
  }
  if (!Object.keys(files).length) throw new Error('No Markdown files found in ' + path);
  return files;
}

function print(result) {
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}

async function poll(seconds, action) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const interval = Number.isFinite(seconds) ? Math.max(seconds, 1) * 1000 : 15_000;
  try {
    while (!ctl.signal.aborted) {
      try {
        await action();
      } catch (error) {
        console.error('SuperWiki: ' + error.message);
      }
      await delay(interval, undefined, { signal: ctl.signal });
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function main(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return help();
  if (argv[0] === '--version') {
    return console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  }
  const pair = argv.slice(0, 2).join(' ');
  const command = Object.hasOwn(commands, pair) ? pair : argv[0];
  if (!Object.hasOwn(commands, command)) throw new Error('Unknown command: ' + pair);
  const args = argv.slice(command.includes(' ') ? 2 : 1);
  if (args.includes('--help')) return console.log('superwiki ' + command + ' ' + commands[command]);

  if (command === 'hook') {
    const { values } = options(args, ['project']);
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    const root = resolve(required(values.project, '--project'));
    if (typeof payload.cwd !== 'string' || !isWithin(root, resolve(payload.cwd))) return print({});
    let cwdRoot;
    try {
      cwdRoot = git({ root: payload.cwd }, ['rev-parse', '--show-toplevel']);
    } catch {
      return print({});
    }
    if (realpathSync(root) !== realpathSync(cwdRoot)) return print({});
    const project = resolveProject(root);
    const { handleHook } = await import('./harness.mjs');
    const result = await handleHook(project, payload, {
      refreshInbox: ({ withWiki }) => run(process.execPath, [fileURLToPath(import.meta.url), 'inbox',
        ...(withWiki ? ['--with-wiki'] : [])], { cwd: project.root, timeout: withWiki ? 7_500 : 4_500 }),
    });
    return print(result ?? {});
  }

  const projects = await import('./project.mjs');
  if (command === 'project attach') {
    const { values } = options(args, ['remote', 'harness']);
    return print(projects.attachProject({ remote: required(values.remote, '--remote'), harness: values.harness }));
  }
  if (command === 'project init') {
    const { values } = options(args, ['remote', 'path', 'harness'], ['seed-bounties']);
    return print(await projects.initializeProject({
      remote: required(values.remote, '--remote'), path: required(values.path, '--path'),
      harness: values.harness, seed: values['seed-bounties'],
    }));
  }

  const project = resolveProject();
  const github = await import('./github.mjs');
  const memory = await import('./memory.mjs');
  switch (command) {
    case 'install': {
      const { values } = options(args, ['role', 'harness']);
      return print(projects.installRole(project, values));
    }
    case 'doctor': {
      const { values } = options(args, ['role']);
      const result = projects.doctor(project, values.role);
      print(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'context':
    case 'search': {
      const isSearch = command === 'search';
      const { values, positionals } = options(args, ['query'], [], isSearch ? 1 : 0);
      return print(projects.context(project, positionals[0] ?? values.query, { searchOnly: isSearch }));
    }
    case 'member run': {
      const { values } = options(args, [], ['once']);
      if (values.once) return print(await projects.refreshMember(project));
      if (!project.config.member) throw new Error('Install the member role first.');
      let previous;
      return poll(project.config.member.poll_seconds, async () => {
        const { wiki, entries } = await projects.refreshMember(project);
        const summary = { sha: wiki.sha, entries: entries.map(({ number, title, url, kind, assignment }) =>
          ({ number, title, url, kind, assignment })) };
        const key = JSON.stringify(summary);
        if (key !== previous) print(summary);
        previous = key;
      });
    }
    case 'memory start': {
      const { values } = options(args, ['session', 'turn', 'title']);
      return print(memory.memoryStart(project, values));
    }
    case 'memory prepare': {
      const { values } = options(args, ['task', 'summary-file', 'import-file']);
      return print(memory.memoryPrepare(project, {
        task: required(values.task, '--task'),
        summary: values['summary-file'] && read(values['summary-file'], '--summary-file'),
        imported: values['import-file'] && read(values['import-file'], '--import-file'),
      }));
    }
    case 'memory save': {
      const { values } = options(args, ['task', 'file'], ['skip', 'complete']);
      if (Boolean(values.file) === Boolean(values.skip)) throw new Error('Choose --file or --skip.');
      return print(memory.memorySave(project, {
        task: required(values.task, '--task'), notes: values.file && JSON.parse(read(values.file, '--file')),
        skip: values.skip, complete: values.complete,
      }));
    }
    case 'bounty list':
      options(args);
      return print(await github.listBounties(project));
    case 'bounty create': {
      const { values } = options(args, ['title', 'body-file', 'seed']);
      if (values.seed) {
        if (!Object.hasOwn(projects.seedBounties, values.seed) || values['body-file'] || values.title) {
          throw new Error('Choose a predefined seed without title or body overrides.');
        }
        await github.ensureLabels(project);
        return print(await github.bountyCreate(project, { ...projects.seedBounties[values.seed], seed: values.seed }));
      }
      const body = read(values['body-file'], '--body-file');
      return print(await github.bountyCreate(project, { title: values.title ?? heading(body), body }));
    }
    case 'proposal create': {
      const { values } = options(args, ['title', 'body-file', 'path', 'file', 'closes', 'changes-dir']);
      const body = read(values['body-file'], '--body-file');
      if (values['changes-dir'] && (values.file || values.path)) throw new Error('Choose one change input mode.');
      let changes;
      if (values['changes-dir']) changes = collectChanges(resolve(values['changes-dir']));
      else {
        const path = required(values.path, '--path');
        trustedRepoPath(path);
        changes = { [path]: read(values.file, '--file') };
      }
      return print(await github.proposalCreate(project, {
        title: values.title ?? heading(body), body, changes,
        closes: values.closes ? number(values.closes) : undefined,
      }));
    }
    case 'inbox': {
      const { values } = options(args, [], ['with-wiki']);
      return print(values['with-wiki'] ? projects.refreshBrief(project) : projects.refreshInbox(project));
    }
    case 'inbox show':
    case 'inbox take':
    case 'inbox reply': {
      const { values, positionals } = options(args, command === 'inbox reply' ? ['body-file'] : [], [], 1);
      const id = number(positionals[0]);
      if (command === 'inbox show') return print(github.getInboxItem(project, id));
      if (command === 'inbox take') return print(await github.inboxTake(project, id));
      return print(await github.inboxReply(project, id, read(values['body-file'], '--body-file')));
    }
    case 'curator run':
    case 'curator run-once': {
      const once = command.endsWith('once');
      const { values } = options(args, once ? ['issue', 'pr'] : [], once ? ['dry-run'] : []);
      if (values.issue && values.pr) throw new Error('Choose --issue or --pr.');
      if (!project.config.curator) throw new Error('Install the curator role first.');
      const cycle = async (current) => {
        const result = await github.runCurator(current, {
          issue: values.issue && number(values.issue), pr: values.pr && number(values.pr), dryRun: values['dry-run'],
        });
        if (once || result.results.length || result.failures.length) print(result);
        if (once && result.failures.length) process.exitCode = 1;
      };
      if (once) return cycle(project);
      return poll(project.config.curator.poll_seconds, () => cycle(resolveProject(project.root)));
    }
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error('SuperWiki: ' + error.message);
  process.exitCode = 1;
}
