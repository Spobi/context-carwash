import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writePrivateJson } from '../files.mjs';
import { statsDir } from '../paths.mjs';

// The savings ledger. Briefs themselves are deleted within days, so each one
// written leaves a small entry here: its level, what writing it cost, and the
// fresh sessions it was delivered to. Nothing in it leaves this machine unless
// the user runs `carwash stats --share` and says yes, and then only totals.
//
// What a wash saves is measured, not assumed. Every request Claude Code sends
// carries the whole conversation. A fresh session's transcript records the
// size of each request, so for every request after a wash the saving is the
// gap between the old session's size and the fresh session's starting size.

const DAY = 24 * 3_600_000;

// Roughly where Claude Code compacts a session on its own. Past this point the
// old session would have shrunk anyway, so requests beyond it count for nothing.
export const AUTO_COMPACT_SHARE = 0.9;

const keyOf = (record) => `${Date.parse(record.createdAt).toString(36)}-${record.id}`;
const fileOf = (env, key) => join(statsDir(env), `${key}.json`);

// A brief was saved. `wash` is the wash that produced it.
export function recordWash(env, record, wash) {
  const key = keyOf(record);
  writePrivateJson(fileOf(env, key), {
    key,
    level: record.level,
    washedAt: record.createdAt,
    used: record.used ?? null,
    size: wash.size ?? null,
    tokens: record.tokens,
    attempts: (wash.rewrites ?? 0) + 1,
    deliveries: [],
  });
}

// A brief was handed to a fresh session.
export function recordDelivery(env, record, payload, now = Date.now()) {
  const file = fileOf(env, keyOf(record));
  const entry = readJson(file);
  if (!entry || typeof payload.transcript_path !== 'string') return;
  entry.deliveries.push({ sessionId: payload.session_id ?? null, transcript: payload.transcript_path, at: new Date(now).toISOString(), measured: null });
  writePrivateJson(file, entry);
}

export function readLedger(env) {
  let names;
  try {
    names = readdirSync(statsDir(env));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const entry = readJson(join(statsDir(env), name));
    if (entry && `${entry.key}.json` === name && Array.isArray(entry.deliveries) && Number.isFinite(Date.parse(entry.washedAt))) entries.push(entry);
  }
  return entries.sort((a, b) => Date.parse(a.washedAt) - Date.parse(b.washedAt));
}

// A line of the transcript the user typed, as opposed to a tool result, a
// shell command, a slash command's output or a compaction summary.
function isPrompt(line) {
  if (line.type !== 'user' || line.isMeta || line.isCompactSummary) return false;
  const content = line.message?.content;
  if (typeof content === 'string') return !content.trimStart().startsWith('<');
  return Array.isArray(content) && content.some((block) => block?.type === 'text') && !content.some((block) => block?.type === 'tool_result');
}

// Count what a fresh session sent after a wash. `before` is the old session's
// size when the brief was written, `size` its context window.
export function measure(text, before, size) {
  const limit = size ? size * AUTO_COMPACT_SHARE : Infinity;
  const seen = new Set();
  let start = null;
  let prompts = 0;
  let requests = 0;
  for (const raw of text.split('\n')) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || line.isSidechain) continue;
    // Compacted: the comparison with the old session no longer holds.
    if (line.type === 'system' && line.subtype === 'compact_boundary') break;
    if (isPrompt(line)) {
      prompts++;
      continue;
    }
    if (line.type !== 'assistant') continue;
    // One request can be written as several lines; they share an id.
    const id = line.message?.id;
    const usage = line.message?.usage;
    if (!id || !usage || seen.has(id)) continue;
    seen.add(id);
    const sent = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    start ??= sent;
    if (before - start <= 0 || sent + (before - start) > limit) break;
    requests++;
  }
  const gap = start === null ? 0 : Math.max(0, before - start);
  return { prompts: requests ? prompts : 0, requests, start, saved: gap * requests };
}

// Bring each delivery's measurement up to date with its transcript. Without
// `force`, a measurement less than a day old is left alone, so a session start
// does not reread transcripts every time. A transcript that has gone (Claude
// Code deletes old ones) keeps its last measurement.
export function refreshLedger(env, { now = Date.now(), force = false } = {}) {
  const entries = readLedger(env);
  for (const entry of entries) {
    if (!(entry.used > 0)) continue;
    let changed = false;
    for (const delivery of entry.deliveries) {
      const last = delivery.measured;
      if (last && !force && now - last.at < DAY) continue;
      let mtime;
      try {
        mtime = statSync(delivery.transcript).mtimeMs;
      } catch {
        continue;
      }
      if (last && last.mtime === mtime) continue;
      let text;
      try {
        text = readFileSync(delivery.transcript, 'utf8');
      } catch {
        continue;
      }
      delivery.measured = { ...measure(text, entry.used, entry.size), mtime, at: now };
      changed = true;
    }
    if (changed) writePrivateJson(fileOf(env, entry.key), entry);
  }
  return entries;
}

// What writing a brief cost: each attempt re-read the old session and wrote
// the brief out.
export const costOf = (entry) => (entry.used > 0 ? entry.attempts * (entry.used + entry.tokens) : 0);

export function totals(entries, now = Date.now()) {
  const sum = { washes: entries.length, levels: {}, delivered: 0, prompts: 0, requests: 0, notResent: 0, briefCost: 0, since: null, days: 0 };
  for (const entry of entries) {
    sum.levels[entry.level] = (sum.levels[entry.level] ?? 0) + 1;
    sum.briefCost += costOf(entry);
    if (entry.deliveries.length) sum.delivered++;
    for (const { measured } of entry.deliveries) {
      if (!measured) continue;
      sum.prompts += measured.prompts;
      sum.requests += measured.requests;
      sum.notResent += measured.saved;
    }
  }
  if (entries.length) {
    sum.since = entries[0].washedAt;
    sum.days = Math.max(1, Math.ceil((now - Date.parse(sum.since)) / DAY));
  }
  return sum;
}
