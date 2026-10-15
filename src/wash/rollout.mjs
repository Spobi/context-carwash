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

// How much context a Codex session is using, from its latest token reading, or
// null when it has none yet (or the file cannot be read).
export function readCodexUsage(file, { tailBytes = TAIL_BYTES } = {}) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('token_count')) continue;
      let line;
      try {
        line = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const reading = tokenReading(line);
      if (reading) return reading;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
