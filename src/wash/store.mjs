import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir, readJson, writePrivateJson } from '../files.mjs';
import { consumedDir, pendingDir, sessionsDir } from '../paths.mjs';

// The store of handoff briefs. One JSON file per brief, outside any project:
// pending/ holds briefs waiting for a fresh session, consumed/ holds delivered
// ones for a while in case they are wanted again.
//
// A record carries the brief text, where it came from (`source`: session,
// folder, branch, HEAD), and its `owner`: the Claude Code process whose next
// /clear delivers it. A brief with no owner, or whose owner has exited, is
// waiting for its folder.

const HOUR = 3_600_000;
export const EXPIRY_MS = 48 * HOUR; // a waiting brief is dropped after this
export const AUTO_LOAD_MS = 12 * HOUR; // older than this, a brief is offered instead of loaded
const RETAIN_HOURS = 24; // how long a delivered brief is kept
const SESSION_NOTE_MS = 7 * 24 * HOUR;

const fileIn = (dir, id) => join(dir, `${id}.json`);
const age = (record, now) => now - Date.parse(record.createdAt);

function readAll(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = readJson(join(dir, name));
    const sound =
      record && typeof record === 'object' && `${record.id}.json` === name && typeof record.brief === 'string' && Number.isFinite(Date.parse(record.createdAt));
    if (sound) records.push(record);
  }
  return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

// Briefs waiting to be delivered, newest first.
export function readyRecords(env, now = Date.now()) {
  return readAll(pendingDir(env)).filter((record) => age(record, now) <= EXPIRY_MS);
}

export function addRecord(env, fields, now = Date.now()) {
  let id;
  do {
    id = randomBytes(3).toString('hex');
  } while (existsSync(fileIn(pendingDir(env), id)) || existsSync(fileIn(consumedDir(env), id)));
  const record = { id, version: 1, state: 'ready', createdAt: new Date(now).toISOString(), ...fields };
  writePrivateJson(fileIn(pendingDir(env), id), record);
  return record;
}

// Rewrite a waiting brief. Does nothing if it has been delivered or discarded
// in the meantime, so an update can never bring one back.
export function updateRecord(env, record) {
  const file = fileIn(pendingDir(env), record.id);
  if (existsSync(file)) writePrivateJson(file, record);
}

export function removeRecord(env, id) {
  try {
    unlinkSync(fileIn(pendingDir(env), id));
    return true;
  } catch {
    return false;
  }
}

// Take a brief for delivery. Moving the file is the claim: of two sessions
// starting at once only one move succeeds, and the other gets null.
export function claim(env, record, sessionId, now = Date.now()) {
  const to = fileIn(privateDir(consumedDir(env)), record.id);
  try {
    renameSync(fileIn(pendingDir(env), record.id), to);
  } catch {
    return null;
  }
  const consumed = { ...record, state: 'consumed', owner: null, consumedAt: new Date(now).toISOString(), consumedBy: sessionId ?? null };
  try {
    writePrivateJson(to, consumed);
  } catch {
    // The claim stands; only the bookkeeping is missing.
  }
  return consumed;
}

// Put a delivered brief back in the waiting pile.
export function reopen(env, record) {
  const { consumedAt, consumedBy, ...rest } = record;
  const ready = { ...rest, state: 'ready' };
  const to = fileIn(privateDir(pendingDir(env)), record.id);
  try {
    renameSync(fileIn(consumedDir(env), record.id), to);
  } catch {
    return null;
  }
  writePrivateJson(to, ready);
  return ready;
}

// Briefs matching an id or the start of one. Each result says where it lives.
export function findRecords(env, ref, now = Date.now()) {
  if (!/^[0-9a-f]{2,}$/.test(ref ?? '')) return [];
  const pool = [
    ...readyRecords(env, now).map((record) => ({ record, consumed: false })),
    ...readAll(consumedDir(env)).map((record) => ({ record, consumed: true })),
  ];
  const exact = pool.filter(({ record }) => record.id === ref);
  return exact.length ? exact : pool.filter(({ record }) => record.id.startsWith(ref));
}

function sweep(dir, isDue) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (isDue(file, name)) unlinkSync(file);
    } catch {
      // gone already, or not ours to remove
    }
  }
}

// Delete what has outlived its use: expired briefs, delivered briefs past
// their retention, old session notes, and stray files.
export function purge(env, now = Date.now()) {
  const setting = (env.CARWASH_RETAIN_HOURS ?? '').trim();
  const retainMs = (setting !== '' && Number(setting) >= 0 ? Number(setting) : RETAIN_HOURS) * HOUR;
  const stale = (file, ms) => now - statSync(file).mtimeMs > ms;
  const dated = (file, name, field) => Date.parse((name.endsWith('.json') && readJson(file)?.[field]) || '');

  sweep(pendingDir(env), (file, name) => {
    const created = dated(file, name, 'createdAt');
    return Number.isFinite(created) ? now - created > EXPIRY_MS : stale(file, HOUR);
  });
  sweep(consumedDir(env), (file, name) => {
    const consumed = dated(file, name, 'consumedAt');
    return Number.isFinite(consumed) ? now - consumed > retainMs : stale(file, HOUR);
  });
  sweep(sessionsDir(env), (file) => stale(file, SESSION_NOTE_MS));
}
