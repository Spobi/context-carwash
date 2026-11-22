import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { readJson, writePrivateJson } from '../files.mjs';
import { cacheChecksPath } from '../paths.mjs';
import { loadCacheNote, saveCacheNote } from '../wash/session.mjs';

// How long Claude's prompt cache for this conversation is likely to stay warm.
//
// The cache's lifetime counts from when a request is sent, not from when its
// reply ends, so a long reply eats into it. Claude Code writes an api-request
// record to the session file as it sends each request, and each reply points
// back to its request (requestRef). For older versions that write no such
// records, the stand-in is the time of the entry the reply answers, which was
// written just before the request went out.
//
// The rule throughout: never show the cache as warm when it might not be. An
// unreadable file, a reply that cannot be tied to a send time, or a reply that
// used no cache at all hides the timer rather than guessing.

// Taken off every lifetime, so the timer is never ahead of the real cache
// between two redraws of the status line.
export const SAFETY_MS = 10_000;

// Two replies this far apart are compared: did the cache really survive the
// pause? Closer ones are steps of one turn, which say nothing about the timer.
export const CHECK_GAP_MS = 60_000;

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 };
const FIRST_READ = 256 * 1024;
export const MAX_READ = 8 * 1024 * 1024;
const MORE = Symbol('read further back');
const RECENT_MISSES = 5;

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const time = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    // a line still being written, or not JSON
    return null;
  }
};

// The shortest lifetime a request asked for, or null when it says nothing.
// A breakpoint with no ttl gets the API's default, five minutes.
export function requestTtl(cacheControl) {
  if (!Array.isArray(cacheControl) || !cacheControl.length) return null;
  let shortest = null;
  for (const entry of cacheControl) {
    const ttl = entry?.value?.ttl ?? '5m';
    if (!TTL_MS[ttl]) return '5m';
    if (!shortest || TTL_MS[ttl] < TTL_MS[shortest]) shortest = ttl;
  }
  return shortest;
}

// A real main-conversation reply: not a subagent's, and not an error Claude
// Code wrote in place of one (those have no tokens).
function asReply(d) {
  if (d?.type !== 'assistant' || d.isSidechain === true || d.agentId || d.isApiErrorMessage) return null;
  const message = d.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object' || message.model === '<synthetic>') return null;
  const read = count(usage.cache_read_input_tokens);
  const written = count(usage.cache_creation_input_tokens);
  if (!read && !written && !count(usage.input_tokens)) return null;
  const t = time(d.timestamp);
  if (!Number.isFinite(t)) return null;
  return {
    t,
    uuid: d.uuid,
    parentUuid: d.parentUuid,
    group: message.id ?? d.requestId ?? d.uuid,
    requestRef: typeof d.requestRef === 'string' ? d.requestRef : null,
    model: typeof message.model === 'string' ? message.model : null,
    asked: d.promptCacheRequested,
    read,
    written,
    wrote5m: count(usage.cache_creation?.ephemeral_5m_input_tokens) > 0,
    wrote1h: count(usage.cache_creation?.ephemeral_1h_input_tokens) > 0,
  };
}

// The lifetime this reply's cache got. Anything written for five minutes
// makes it five minutes, whatever was asked for.
function lifetime(reply, asked) {
  if (reply.wrote5m) return '5m';
  if (asked) return asked;
  if (TTL_MS[reply.asked]) return reply.asked;
  return reply.wrote1h ? '1h' : '5m';
}

// What the lines say, or MORE when the answer lies further back than they go.
function resolve(lines, complete) {
  const requests = new Map();
  const firsts = new Map();
  let reply = null;
  let compactAt = -Infinity;
  let sawRequests = false;
  for (const line of lines) {
    if (!line) continue;
    const isRequest = /"type":"api-request"[,}]/.test(line);
    const isReply = line.includes('"type":"assistant"');
    const isCompact = line.includes('"compact_boundary"');
    if (!isRequest && !isReply && !isCompact) continue;
    const d = parse(line);
    if (!d) continue;
    if (d.type === 'api-request' && typeof d.id === 'string') {
      sawRequests = true;
      requests.set(d.id, { at: time(d.timestamp), model: d.params?.model, ttl: requestTtl(d.cacheControl) });
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      const t = time(d.timestamp);
      if (Number.isFinite(t) && t > compactAt) compactAt = t;
    } else {
      const r = asReply(d);
      if (!r) continue;
      const first = firsts.get(r.group);
      if (!first || r.t < first.t) firsts.set(r.group, r);
      if (!reply || r.t >= reply.t) reply = r;
    }
  }
  if (!reply) return complete ? null : MORE;

  const cached = reply.read + reply.written;
  // Caching is off (or this reply was too small to cache): nothing to time.
  if (!cached) return null;
  const base = { model: reply.model, cached, read: reply.read, compactAt: Number.isFinite(compactAt) ? compactAt : null };

  const request = reply.requestRef ? requests.get(reply.requestRef) : null;
  if (request && Number.isFinite(request.at)) {
    const ttl = lifetime(reply, request.ttl);
    return finish({ ...base, key: reply.requestRef, at: request.at, ttlMs: TTL_MS[ttl], model: typeof request.model === 'string' ? request.model : reply.model, method: 'requests' });
  }
  if (reply.requestRef && !complete) return MORE;
  if (sawRequests && reply.requestRef) return null;

  // Older Claude Code: the reply's first entry answers the entry written just
  // before the request was sent, so that entry's time is never late.
  const first = firsts.get(reply.group) ?? reply;
  const needle = typeof first.parentUuid === 'string' ? `"uuid":"${first.parentUuid}"` : null;
  if (!needle) return null;
  const parentLine = lines.find((line) => line.includes(needle));
  if (!parentLine) return complete ? null : MORE;
  const at = time(parse(parentLine)?.timestamp);
  if (!Number.isFinite(at) || at > first.t) return null;
  return finish({ ...base, key: reply.group, at, ttlMs: TTL_MS[lifetime(reply, null)], method: 'replies' });
}

// A compaction after the reply replaced the conversation the cache held: the
// next message writes a new, smaller one. Nothing to time until it does.
function finish(found) {
  return found.compactAt !== null && found.compactAt > found.at ? null : found;
}

function readTail(fd, size, bytes) {
  const start = Math.max(0, size - bytes);
  const buffer = Buffer.alloc(size - start);
  let filled = 0;
  while (filled < buffer.length) {
    const n = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
    if (!n) break;
    filled += n;
  }
  let text = buffer.subarray(0, filled).toString('utf8');
  // The first line is cut unless the read began at the start of the file.
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  return { lines: text.split('\n'), whole: start === 0 };
}

// The last cache write this session file shows: { key, at, ttlMs, model,
// method, cached, read, compactAt }, or null. Reads only the end of the file,
// going further back only when it has to, and never more than MAX_READ.
export function readCache(file, { maxBytes = MAX_READ } = {}) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    for (let bytes = Math.min(FIRST_READ, maxBytes); ; bytes *= 4) {
      const window = Math.min(bytes, maxBytes);
      const { lines, whole } = readTail(fd, size, window);
      const found = resolve(lines, whole || window >= maxBytes);
      if (found !== MORE) return found;
      if (whole || window >= maxBytes) return null;
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// Model ids as Claude Code writes them, minus a context-size tag such as [1m].
const sameModel = (a, b) => String(a).replace(/\[[^\]]*\]$/, '').toLowerCase() === String(b).replace(/\[[^\]]*\]$/, '').toLowerCase();

export const timerOff = (env = process.env) => Boolean(env.CARWASH_NO_CACHE_TIMER) && env.CARWASH_NO_CACHE_TIMER !== '0';

export function readChecks(env = process.env) {
  const data = readJson(cacheChecksPath(env));
  return data && typeof data === 'object' ? data : null;
}

// The self-check. When a reply comes in after a pause that the timer said the
// cache would survive, the reply shows whether it really did: it read most of
// what was cached before, or it wrote it all again. Misses are kept for
// `carwash doctor`, so a timer that is wrong in real use gets noticed.
export function checkCache(env, before, after, now = Date.now()) {
  if (!after) return;
  const checks = readChecks(env) ?? {};
  let changed = checks.method !== after.method;
  checks.method = after.method;
  const comparable =
    before &&
    before.key !== after.key &&
    after.at - before.at >= CHECK_GAP_MS &&
    after.at <= before.at + before.ttlMs - SAFETY_MS &&
    before.cached > 0 &&
    before.model &&
    sameModel(before.model, after.model) &&
    !(after.compactAt !== null && after.compactAt > before.at);
  if (comparable) {
    changed = true;
    checks.checked = count(checks.checked) + 1;
    if (after.read < before.cached / 2) {
      checks.missed = count(checks.missed) + 1;
      const miss = { at: new Date(now).toISOString(), pausedMin: Math.round((after.at - before.at) / 60_000), ttlMin: before.ttlMs / 60_000, expected: before.cached, read: after.read };
      checks.misses = [...(Array.isArray(checks.misses) ? checks.misses : []), miss].slice(-RECENT_MISSES);
    }
  }
  if (changed) writePrivateJson(cacheChecksPath(env), checks);
}

// What the status line shows: { leftMs, ttlMs }, leftMs at or below zero once
// the cache has expired, or null to show nothing. The session file is read
// again only when it has changed since the last redraw.
export function cacheTimer(payload, { env = process.env, now = Date.now(), read = readCache } = {}) {
  if (timerOff(env)) return null;
  const file = payload?.transcript_path;
  const sessionId = payload?.session_id;
  if (typeof file !== 'string' || !file) return null;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  const note = loadCacheNote(env, sessionId);
  let found;
  if (note && note.file === file && note.size === stat.size && note.mtimeMs === stat.mtimeMs) {
    found = note.found ?? null;
  } else {
    found = read(file);
    try {
      checkCache(env, note?.file === file ? note.found : null, found, now);
    } catch {
      // the timer still works without its check
    }
    saveCacheNote(env, sessionId, { file, size: stat.size, mtimeMs: stat.mtimeMs, found });
  }
  if (!found || !Number.isFinite(found.at) || !Number.isFinite(found.ttlMs)) return null;

  // Each model has its own cache: after a switch the next message starts cold.
  const current = payload?.model?.id;
  if (typeof current === 'string' && current && found.model && !sameModel(current, found.model)) return { leftMs: 0, ttlMs: found.ttlMs };
  const leftMs = Math.min(found.at + found.ttlMs - SAFETY_MS - now, found.ttlMs - SAFETY_MS);
  return { leftMs, ttlMs: found.ttlMs };
}
