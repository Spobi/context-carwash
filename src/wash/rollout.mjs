import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Codex keeps each session in a "rollout" file: one JSON object per line. Codex
// says the format is not a stable interface, so everything here reads it
// defensively and anything unexpected is simply not counted.
//
// After each request to the model Codex writes a token_count event, whose
// last_token_usage.input_tokens is everything that request sent: the context
// in use at that point. The status line gives Claude Code's equivalent.

// Only the end of a long session file is read for the latest reading.
const TAIL_BYTES = 4 * 1024 * 1024;

// { used, size } from one rollout line, or null if it is not a token reading.
export function tokenReading(line) {
  const payload = line?.type === 'event_msg' ? line.payload : null;
  if (payload?.type !== 'token_count') return null;
  const used = payload.info?.last_token_usage?.input_tokens;
  if (!Number.isFinite(used) || used <= 0) return null;
  const size = payload.info.model_context_window;
  return { used, size: Number.isFinite(size) && size > 0 ? size : null };
}

// The session file opens with a session_meta line, which can be long: it holds
// the model's base instructions.
const META_BYTES = 1024 * 1024;

// The version of Codex that wrote a session file (its cli_version), or null.
export function readCodexVersion(file) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(fstatSync(fd).size, META_BYTES));
    readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.toString('utf8').split('\n', 1)[0];
    const line = JSON.parse(first);
    const version = line?.type === 'session_meta' ? line.payload?.cli_version : null;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Whether a rollout line is a finished reply from the model.
function isReply(line) {
  const payload = line?.payload;
  if (line?.type === 'event_msg') return payload?.type === 'item_completed' && payload.item?.type === 'AgentMessage';
  return line?.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant';
}

// The latest token reading and whether it came after the latest reply, or null.
function latestReading(file, tailBytes) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    let afterReply = true;
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i];
      const maybeReading = text.includes('token_count');
      if (!maybeReading && !(afterReply && (text.includes('AgentMessage') || text.includes('"assistant"')))) continue;
      let line;
      try {
        line = JSON.parse(text);
      } catch {
        continue;
      }
      const reading = maybeReading ? tokenReading(line) : null;
      if (reading) return { reading, afterReply };
      if (isReply(line)) afterReply = false;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// How much context a Codex session is using, from its latest token reading, or
// null when it has none yet (or the file cannot be read).
export function readCodexUsage(file, { tailBytes = TAIL_BYTES } = {}) {
  return latestReading(file, tailBytes)?.reading ?? null;
}

// The reading for the reply that just ended, for the meter Codex shows after
// it. Codex writes that reply's token_count a few milliseconds before its Stop
// hook runs, close enough that the file may not have it yet. Until a reading
// follows the reply, it is read again, briefly; after that the older reading
// is used, which is only one request behind.
const SETTLE_MS = 250;
const RETRY_MS = 25;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function readCodexReplyUsage(file, { tailBytes = TAIL_BYTES, settleMs = SETTLE_MS, wait = pause } = {}) {
  let latest = latestReading(file, tailBytes);
  for (let waited = 0; latest && !latest.afterReply && waited < settleMs; waited += RETRY_MS) {
    wait(RETRY_MS);
    latest = latestReading(file, tailBytes);
  }
  return latest?.reading ?? null;
}
