import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJson, writePrivateJson } from '../files.mjs';
import { errorLogPath, errorsSeenPath, noticePath } from '../paths.mjs';
import { isNewer } from './update.mjs';

// Whether this copy is out of date, and any warning the author has put on it.
//
// At most once a day, a new session starts a background read of Carwash's
// public page on npm: the newest version, and the `npm deprecate` message for
// each version, if any. Nothing about the user is sent. The answer is kept in
// ~/.carwash/notice.json, where the status line and session start read it
// without going online themselves. CARWASH_NO_UPDATE_CHECK turns all of it off.

const PACKAGE_URL = 'https://registry.npmjs.org/context-carwash';
const TIMEOUT_MS = 5000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_WARNING = 200;

export const UPDATE_COMMAND = 'npx context-carwash@latest install';
export const DOCTOR_COMMAND = 'npx context-carwash doctor';

const optedOut = (env) => Boolean(env.CARWASH_NO_UPDATE_CHECK);

// Author text goes on the user's screen, so no control characters (escape
// sequences could restyle or rewrite the terminal) and no essays.
function cleanWarning(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > MAX_WARNING ? `${flat.slice(0, MAX_WARNING - 1)}…` : flat;
}

// What npm says about `version`: { latest, warning }, or null when it cannot
// say in time. Offline or odd answers are no answer, never an error.
export async function fetchNotice(version, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  if (optedOut(env)) return null;
  try {
    // The abbreviated document: dist-tags and per-version deprecation only.
    const response = await fetch(PACKAGE_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/vnd.npm.install-v1+json' } });
    if (!response.ok) return null;
    const doc = await response.json();
    const latest = doc?.['dist-tags']?.latest;
    if (typeof latest !== 'string') return null;
    return { latest, warning: cleanWarning(doc?.versions?.[version]?.deprecated) };
  } catch {
    return null;
  }
}

export const readNotice = (env = process.env) => readJson(noticePath(env));

// The background half: ask npm and keep the answer. A failed check keeps the
// last good answer, so going offline does not hide a warning.
export async function refreshNotice(version, { env = process.env, now = Date.now(), fetchNotice: ask = fetchNotice } = {}) {
  const answer = await ask(version, { env });
  const previous = readNotice(env) ?? {};
  if (!answer) return previous;
  const next = { ...previous, checkedAt: new Date(now).toISOString(), version, latest: answer.latest, warning: answer.warning };
  writePrivateJson(noticePath(env), next);
  return next;
}

// Called as a session starts. Starts a check if the last one is a day old,
// and returns at once: the session never waits for the network. The attempt is
// noted first, so sessions opened together, or a machine that is offline, try
// once a day and not on every start.
export function startCheck(version, { env = process.env, now = Date.now(), run = spawnCheck } = {}) {
  if (optedOut(env)) return false;
  const previous = readNotice(env) ?? {};
  const last = Date.parse(previous.attemptedAt ?? '');
  if (Number.isFinite(last) && now - last < CHECK_EVERY_MS && now >= last) return false;
  writePrivateJson(noticePath(env), { ...previous, attemptedAt: new Date(now).toISOString() });
  run(env);
  return true;
}

function spawnCheck(env) {
  const script = fileURLToPath(new URL('../../bin/carwash.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'update-check'], { env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// What to tell someone running `version`, from what the last check found:
// { kind: 'warning' | 'update', latest, warning }, or null.
export function noticeFor(notice, version, env = process.env) {
  if (optedOut(env) || !notice) return null;
  const newer = isNewer(notice.latest, version);
  // A warning is about the version it was read for. After an update it no
  // longer applies, even before the next check.
  if (notice.warning && notice.version === version) return { kind: 'warning', latest: newer ? notice.latest : null, warning: notice.warning };
  if (newer) return { kind: 'update', latest: notice.latest, warning: null };
  return null;
}

// Hook errors since someone last looked at them with `carwash doctor`.
// Install counts as looking, so errors from before an update do not nag.
export function unseenErrors(env = process.env) {
  try {
    const logged = statSync(errorLogPath(env)).mtimeMs;
    let seen = 0;
    try {
      seen = statSync(errorsSeenPath(env)).mtimeMs;
    } catch {
      // never looked
    }
    return logged > seen;
  } catch {
    return false;
  }
}

// One line for under the meter, or null: the author's warning first, then
// hook errors, then a plain "newer version".
export function statusNotice(version, env = process.env) {
  const notice = noticeFor(readNotice(env), version, env);
  if (notice?.kind === 'warning') return `⚠ Carwash: ${notice.warning} · to update: ${UPDATE_COMMAND}`;
  if (unseenErrors(env)) return `Carwash hit an error · details: ${DOCTOR_COMMAND}`;
  if (notice?.kind === 'update') return `Carwash ${notice.latest} is out (you have ${version}) · ${UPDATE_COMMAND}`;
  return null;
}

// Said once as a session starts, when there is something to say.
export function startNotice(version, env = process.env) {
  const notice = noticeFor(readNotice(env), version, env);
  if (!notice) return null;
  if (notice.kind === 'warning') return `Carwash ${version}: ${notice.warning} To update: ${UPDATE_COMMAND}`;
  return `Carwash ${notice.latest} is out (you have ${version}). To update: ${UPDATE_COMMAND}`;
}

// Which version this is, for /wash help, with what the last check found.
export function versionLine(version, env = process.env) {
  const notice = noticeFor(readNotice(env), version, env);
  let line = `Carwash ${version}.`;
  if (notice?.kind === 'warning') line += ` ${notice.warning} To update: ${UPDATE_COMMAND}`;
  else if (notice?.kind === 'update') line += ` ${notice.latest} is out. To update: ${UPDATE_COMMAND}`;
  return `${line} Something not working? Run in a terminal: ${DOCTOR_COMMAND}`;
}
