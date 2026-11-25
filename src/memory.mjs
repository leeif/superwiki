import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { atomicWrite, hash, readJson, withLock } from './core.mjs';

const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const taskIdPattern = /^(?:[a-f\d]{24}-)?[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;

function digest(value) {
  return hash(JSON.stringify(value));
}

function safeComponent(value) {
  if (/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value) && !windowsDevice.test(value)) return value;
  return `~${digest(value)}`;
}

function memoryPaths(project) {
  const profile = project.config?.member?.profile || 'generic';
  return {
    root: project.root,
    profile,
    transcripts: path.join(project.memory, 'transcripts', safeComponent(profile)),
    notes: path.join(project.memory, 'notes'),
    index: path.join(project.memory, 'index.md'),
    tasks: path.join(project.state, 'memory-tasks'),
    journal: path.join(project.state, 'memory-save.json'),
    lock: path.join(project.state, 'memory.lock'),
  };
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function taskFile(paths, id) {
  if (typeof id !== 'string' || !taskIdPattern.test(id)) throw new Error('Invalid memory task ID.');
  return path.join(paths.tasks, `${id}.json`);
}

function readTask(paths, id) {
  const state = readJson(taskFile(paths, id), null);
  if (!state) throw new Error(`Memory task ${id} does not exist.`);
  if (state.task.profile !== paths.profile) throw new Error(`Memory task ${id} belongs to another profile.`);
  return state;
}

function setup(paths) {
  for (const directory of [paths.notes, paths.transcripts, paths.tasks]) mkdirSync(directory, { recursive: true });
  if (!existsSync(paths.index)) writeIndex(paths);
}

function withMemory(project, operation, { recover = true } = {}) {
  const paths = memoryPaths(project);
  return withLock(paths.lock, () => {
    setup(paths);
    if (recover) finishSave(paths, readJson(paths.journal, null));
    return operation(paths);
  });
}

export function initializeMemory(project) {
  withMemory(project, () => {});
}

function transcriptFile(paths, session) {
  return path.join(paths.transcripts, `${safeComponent(session)}.jsonl`);
}

function readTranscript(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function captureTurn(project, event) {
  const { hook_event_name: name, session_id: sessionId, turn_id: turnId, transcript_path: transcriptPath } = event;
  if (name !== 'UserPromptSubmit' && name !== 'Stop') return { captured: false };
  const role = name === 'UserPromptSubmit' ? 'user' : 'assistant';
  const text = role === 'user' ? event.prompt : event.last_assistant_message;
  if (typeof text !== 'string' || !text.trim() ||
      typeof sessionId !== 'string' || !sessionId || typeof turnId !== 'string' || !turnId) {
    return { captured: false };
  }

  return withMemory(project, paths => {
    const file = transcriptFile(paths, sessionId);
    const records = readTranscript(file);
    if (records.some(record => record.turnId === turnId && record.role === role)) {
      return { captured: false, duplicate: true };
    }
    records.push({
      sessionId, turnId, role, text, capturedAt: new Date().toISOString(),
      ...(typeof transcriptPath === 'string' && transcriptPath ? { transcriptPath } : {}),
    });
    atomicWrite(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    return { captured: true };
  }, { recover: false });
}

export function memoryStart(project, { session = null, turn = null, title = null } = {}) {
  return withMemory(project, paths => {
    const prefix = session && turn ? `${digest([paths.profile, session, turn]).slice(0, 24)}-` : '';
    if (prefix) {
      for (const filename of readdirSync(paths.tasks)) {
        if (!filename.startsWith(prefix) || !filename.endsWith('.json')) continue;
        const { task } = readTask(paths, filename.slice(0, -5));
        if (task.status === 'active') return task;
      }
    }
    const task = {
      id: `${prefix}${randomUUID()}`, profile: paths.profile, session, turn, title,
      status: 'active', startedAt: new Date().toISOString(),
    };
    const anchor = session ? readTranscript(transcriptFile(paths, session)).length : 0;
    writeJson(taskFile(paths, task.id), { task, anchor, processed: [], prepared: null, lastSave: null });
    return task;
  });
}

function scopedTurns(paths, task, anchor) {
  if (!task.session) return [];
  const records = readTranscript(transcriptFile(paths, task.session));
  const start = task.turn ? records.findIndex(record => record.turnId === task.turn) : -1;
  const scopeStart = start === -1 ? anchor : start;
  const turns = new Map();
  for (const [index, record] of records.entries()) {
    if (!turns.has(record.turnId)) turns.set(record.turnId, { turnId: record.turnId, index });
    turns.get(record.turnId)[record.role] = record;
  }
  return [...turns.values()].filter(turn => turn.index >= scopeStart).map(({ index, ...turn }) => turn);
}

function component(kind, value) {
  return value ? `${kind}:${digest(value)}` : null;
}

export function memoryPrepare(project, { task: id, summary, imported } = {}) {
  return withMemory(project, paths => {
    const state = readTask(paths, id);
    const { task, anchor, lastSave } = state;
    const processed = new Set(state.processed);
    const components = [];
    function isNew(key) {
      if (!key || processed.has(key)) return false;
      components.push(key);
      return true;
    }

    const turns = [];
    const pendingTurns = [];
    if (task.status === 'active') {
      for (const turn of scopedTurns(paths, task, anchor)) {
        const complete = Boolean(turn.user && turn.assistant);
        if (complete && isNew(component('turn', turn.turnId))) turns.push(turn);
        if (!complete && isNew(component('pending', [turn.turnId, Boolean(turn.user)]))) pendingTurns.push(turn);
      }
    }

    summary ??= state.prepared?.summary;
    imported ??= state.prepared?.imported;
    summary = task.status === 'active' && isNew(component('summary', summary)) ? summary : null;
    imported = task.status === 'active' && isNew(component('import', imported)) ? imported : null;
    const inputVersion = components.length || !lastSave ? digest(components) : lastSave.inputVersion;
    const prepared = { inputVersion, components, turns, pendingTurns, summary, imported };
    if (task.status === 'active') writeJson(taskFile(paths, id), { ...state, prepared });

    const firstTurn = turns[0] ?? pendingTurns[0];
    const query = [task.title, summary, firstTurn?.user?.text, imported].filter(Boolean).join(' ').slice(0, 4000);
    return { task, inputVersion, turns, pendingTurns, summary, imported, notes: findNotes(paths, query, 6) };
  });
}

function validateNotes(paths, draft) {
  const notes = Array.isArray(draft) ? draft : draft?.notes;
  if (!Array.isArray(notes) || !notes.length) throw new Error('Supply an array of notes or use --skip.');
  const names = new Set();
  const existing = new Map(readdirSync(paths.notes).map(name => [name.toLowerCase(), name]));
  return notes.map(note => {
    const name = note?.path;
    if (typeof name !== 'string' || name.length > 200 || !/^[a-z\d][a-z\d_.-]*\.md$/i.test(name) || windowsDevice.test(name)) {
      throw new Error('Each note path must be a Markdown filename relative to the project notes directory.');
    }
    if (typeof note.text !== 'string' || !note.text.trim()) throw new Error(`Note ${name} has no text.`);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Repeated note path ${name}.`);
    names.add(key);

    const filename = existing.get(key) ?? name;
    const file = path.join(paths.notes, filename);
    if (existing.has(key) && !lstatSync(file).isFile()) throw new Error(`Invalid note path ${name}.`);
    return { filename, text: note.text.endsWith('\n') ? note.text : `${note.text}\n` };
  });
}

function finishSave(paths, journal) {
  if (!journal) return;
  for (const note of journal.notes) atomicWrite(path.join(paths.notes, note.filename), note.text);
  if (journal.notes.length) writeIndex(paths);
  writeJson(taskFile(paths, journal.state.task.id), journal.state);
  rmSync(paths.journal);
}

export function memorySave(project, { task: id, notes, skip = false, complete = false, inputVersion } = {}) {
  if (skip && notes !== undefined) throw new Error('Supply notes or use --skip.');
  return withMemory(project, paths => {
    const state = readTask(paths, id);
    const { task, prepared, lastSave } = state;
    const version = prepared?.inputVersion ?? lastSave?.inputVersion;
    if (!version) throw new Error(`Prepare memory task ${id} before saving.`);
    inputVersion ??= notes?.inputVersion;
    if (inputVersion !== undefined && inputVersion !== version) {
      throw new Error('The memory input version changed. Prepare the task again before saving.');
    }
    if (lastSave?.inputVersion === version) {
      if (complete && !lastSave.complete) {
        task.status = 'complete';
        task.completedAt = new Date().toISOString();
        lastSave.complete = true;
        writeJson(taskFile(paths, id), { ...state, prepared: null });
      }
      return { ...lastSave, duplicate: true };
    }

    const written = skip ? [] : validateNotes(paths, notes);
    if (complete) {
      task.status = 'complete';
      task.completedAt = new Date().toISOString();
    }
    const save = {
      task: id, inputVersion: version, paths: written.map(note => notePath(paths, note.filename)),
      skipped: skip, complete, duplicate: false,
    };
    const next = {
      ...state, task, prepared: null, lastSave: save,
      processed: [...state.processed, ...prepared.components],
    };
    if (!written.length) {
      writeJson(taskFile(paths, id), next);
      return save;
    }
    // A saved intent lets the next locked operation finish an interrupted multi-file update.
    const journal = { notes: written, state: next };
    writeJson(paths.journal, journal);
    finishSave(paths, journal);
    return save;
  });
}

function noteFiles(paths) {
  return readdirSync(paths.notes, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.md$/i.test(entry.name))
    .map(entry => entry.name).sort();
}

function notePath(paths, filename) {
  return path.relative(paths.root, path.join(paths.notes, filename)).split(path.sep).join('/');
}

function writeIndex(paths) {
  const lines = noteFiles(paths).map(name => `- [${name.replace(/[\[\]\\]/g, '\\$&')}](notes/${encodeURIComponent(name)})`);
  atomicWrite(paths.index, `# Local memory\n${lines.length ? `\n${lines.join('\n')}\n` : ''}`);
}

function searchTerms(query) {
  const normalized = query.normalize('NFKC').toLowerCase();
  const terms = normalized.match(/[^\W_]+|\p{Script=Han}+/gu) ?? [];
  const split = terms.flatMap(term => {
    if (!/^\p{Script=Han}+$/u.test(term)) return [term];
    const chars = [...term];
    return chars.length < 2 ? chars : chars.slice(1).map((char, index) => chars[index] + char);
  });
  return [...new Set(split)];
}

function findNotes(paths, query, limit) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const hits = [];
  for (const filename of noteFiles(paths)) {
    const text = readFileSync(path.join(paths.notes, filename), 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? filename;
    const label = `${filename} ${title}`.normalize('NFKC').toLowerCase();
    const body = text.normalize('NFKC').toLowerCase();
    const score = terms.reduce((sum, term) => sum + (label.includes(term) ? 3 : Number(body.includes(term))), 0);
    if (score) hits.push({ path: notePath(paths, filename), title, text, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

export function searchMemory(project, query = '', limit = 6) {
  return withMemory(project, paths => findNotes(paths, query, limit));
}
