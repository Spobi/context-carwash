import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writePrivateJson } from '../files.mjs';
import { claudeConfigDir, habitsPath } from '../paths.mjs';
import { DEFAULT_SHARE, isPrompt, sentOf } from './ledger.mjs';

// How far this person usually takes a session, learned from their own Claude
// Code transcripts. A wash saves context only for the prompts that would
// otherwise have been sent in the old session, and that depends on habit:
// someone who often clears at 300k would not have gone on for long past it.
// Everything here stays on this machine; the cache holds only sizes.

const PRIOR_WEIGHT = 10; // the starting guess counts as this many sessions
const SETTLE_MS = 3_600_000; // touched this recently, a session may still be going
const FIRST_READ_MS = 90 * 24 * 3_600_000; // older transcripts are not read for the first time

const WASH = /<command-name>\/wash<\/command-name>(?:\\n)?<command-args>(?:light|mid|detailed)?<\/command-args>/;

// A session's shape: its size when each prompt was answered, whether it
// compacted (so went on to the limit), and whether it ended in a wash.
export function sessionShape(text) {
  const sizes = [];
  let waiting = false;
  let compacted = false;
  for (const raw of text.split('\n')) {
    if (!raw.includes('"user"') && !raw.includes('"usage"') && !raw.includes('compact_boundary')) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || line.isSidechain) continue;
    if (line.type === 'system' && line.subtype === 'compact_boundary') {
      compacted = true;
      break;
    }
    if (isPrompt(line)) waiting = true;
    else if (waiting && line.type === 'assistant' && line.message?.usage) {
      sizes.push(sentOf(line.message.usage));
      waiting = false;
    }
  }
  return { sizes, compacted, washed: WASH.test(text) };
}

// Bring the cache up to date with Claude Code's transcripts and return every
// session's shape. Transcripts Claude Code has since deleted stay in the cache.
export function learnHabits(env, { now = Date.now() } = {}) {
  const file = habitsPath(env);
  const sessions = readJson(file)?.sessions ?? {};
  const root = join(claudeConfigDir(env), 'projects');
  let changed = false;
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    // no transcripts
  }
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(root, dir, name);
      try {
        const { mtimeMs } = statSync(path);
        if (now - mtimeMs < SETTLE_MS || sessions[path]?.mtime === mtimeMs) continue;
        if (!sessions[path] && now - mtimeMs > FIRST_READ_MS) continue;
        sessions[path] = { mtime: mtimeMs, ...sessionShape(readFileSync(path, 'utf8')) };
        changed = true;
      } catch {
        continue;
      }
    }
  }
  if (changed) {
    try {
      writePrivateJson(file, { version: 1, sessions });
    } catch {
      // learned again next time
    }
  }
  return Object.values(sessions).filter((s) => !s.washed && Array.isArray(s.sizes) && s.sizes.length);
}

// The share of `turns` prompts, sent after washing a session of `before`
// tokens, that would likely have been sent in that session anyway. Each past
// session that reached the same size says how many more prompts it went on
// for; one that compacted went on to the limit. The starting guess holds until
// enough sessions have reached that size to outweigh it.
export function shareFor(sessions, before, turns) {
  if (!(turns > 0) || !(before > 0)) return DEFAULT_SHARE;
  let seen = 0;
  let kept = 0;
  for (const { sizes, compacted } of sessions) {
    const at = sizes.findIndex((size) => size >= before);
    if (at < 0) continue;
    seen++;
    kept += compacted ? 1 : Math.min(turns, sizes.length - 1 - at) / turns;
  }
  return (DEFAULT_SHARE * PRIOR_WEIGHT + kept) / (PRIOR_WEIGHT + seen);
}
