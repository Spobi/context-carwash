import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir, readJson, writeFileAtomic, writePrivateJson } from '../files.mjs';
import { sessionsDir } from '../paths.mjs';

// Small notes kept per session, so the status line and the hooks (separate,
// short-lived processes) can tell each other things.

// A wash that has not produced a brief after this long is taken as abandoned.
export const WASH_TIMEOUT_MS = 15 * 60_000;

function note(env, sessionId, kind) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return null;
  return join(sessionsDir(env), `${sessionId}.${kind}.json`);
}

// The status line's latest reading of how much context is in use. The /wash
// hook sizes a brief from it, so the cap matches what the meter showed.
export function saveUsage(env, sessionId, { used, size }) {
  const file = note(env, sessionId, 'usage');
  if (!file) return;
  const text = JSON.stringify({ used, size });
  try {
    if (readFileSync(file, 'utf8') === text) return;
  } catch {
    // first reading for this session
  }
  privateDir(sessionsDir(env));
  writeFileAtomic(file, text, 0o600);
}

export function loadUsage(env, sessionId) {
  const file = note(env, sessionId, 'usage');
  const usage = file && readJson(file);
  return usage && Number.isFinite(usage.used) && usage.used > 0 ? usage : null;
}

// A wash in progress: /wash was run and its reply has not been captured yet.
export function startWash(env, sessionId, wash) {
  const file = note(env, sessionId, 'wash');
  if (file) writePrivateJson(file, wash);
}

export function currentWash(env, sessionId, now = Date.now()) {
  const file = note(env, sessionId, 'wash');
  const wash = file && readJson(file);
  if (!wash || !Number.isFinite(wash.startedAt) || now - wash.startedAt > WASH_TIMEOUT_MS) return null;
  return wash;
}

export function endWash(env, sessionId) {
  const file = note(env, sessionId, 'wash');
  try {
    if (file) unlinkSync(file);
  } catch {
    // nothing in progress
  }
}
