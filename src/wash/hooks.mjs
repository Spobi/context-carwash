import { DEFAULT_LEVEL, capFor, estimateTokens, isLevel } from '../levels.mjs';
import { budgetNote, composeContext, describe, loadedMessage, parseReply, pointerMessage, readyMessage, retryNote, stalenessLine } from './brief.mjs';
import { repoState, worktreeRoot } from './git.mjs';
import { currentProcess, isRunning, sameProcess } from './process.mjs';
import { currentWash, endWash, loadUsage, startWash } from './session.mjs';
import { AUTO_LOAD_MS, addRecord, claim, findRecords, purge, readyRecords, removeRecord, reopen, updateRecord } from './store.mjs';

// Carwash's three Claude Code hooks:
//
//   UserPromptExpansion  /wash was typed. A level starts a wash and tells
//                        Claude the size limit; discard and load are handled
//                        here and never reach Claude.
//   Stop                 Claude finished replying. If that reply is the brief,
//                        save it.
//   SessionStart         A session began. If a brief is meant for it, hand the
//                        brief over.
//
// Each handler returns the JSON to print for Claude Code, or null to stay out
// of the way. None of them ever clears, restarts, or runs anything.

const USAGE = 'Usage: /wash [light | mid | detailed], /wash discard [id], /wash load [id]';

// How many times to ask for a shorter brief before keeping an oversized one.
const MAX_REWRITES = 2;

// Stops the command before it reaches Claude: no model turn, no cost. Claude
// Code shows the reason under "operation blocked by hook", so it names us.
const block = (reason) => ({ decision: 'block', reason: `Carwash: ${reason}` });

// A `claude -p` run or other unattended session has nobody to carry on a
// conversation, so it must not use up a brief meant for a person.
const unattended = (env) => env.CLAUDE_CODE_SESSION_ATTENDED === '0' || /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? '');

const cwdOf = (payload) => (typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());

// --- /wash ---------------------------------------------------------------

function onExpansion(payload, ctx) {
  if (String(payload.command_name ?? '').replace(/^\//, '') !== 'wash') return null;
  const [verb = DEFAULT_LEVEL, ref] = String(payload.command_args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (isLevel(verb)) return begin(payload, verb, ctx);
  if (verb === 'discard') return block(discard(payload, ref, ctx));
  if (verb === 'load') return block(load(payload, ref, ctx));
  return block(`/wash does not know "${verb}". ${USAGE}`);
}

function begin(payload, level, { env, now }) {
  const used = loadUsage(env, payload.session_id)?.used ?? null;
  const cap = capFor(level, used);
  startWash(env, payload.session_id, { promptId: payload.prompt_id ?? null, level, cap, used, startedAt: now, rewrites: 0 });
  return { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: budgetNote(level, cap, used) } };
}

// Briefs waiting for the folder this session is in, other than its own.
function waitingHere(payload, { env, now, me }) {
  const here = worktreeRoot(cwdOf(payload));
  return readyRecords(env, now).filter((record) => record.source?.worktree === here && !sameProcess(record.owner, me));
}

function discard(payload, ref, ctx) {
  const { env, now, me } = ctx;
  endWash(env, payload.session_id);
  if (ref) {
    const found = findRecords(env, ref, now).filter((match) => !match.consumed);
    if (found.length > 1) return `"${ref}" matches more than one brief: ${found.map(({ record }) => describe(record, now)).join(' · ')}. Nothing was discarded.`;
    if (!found.length) return `no waiting brief has the id "${ref}". Nothing was discarded.`;
    removeRecord(env, found[0].record.id);
    return `discarded brief ${describe(found[0].record, now)}.`;
  }
  const mine = readyRecords(env, now).filter((record) => sameProcess(record.owner, me));
  if (mine.length) {
    for (const record of mine) removeRecord(env, record.id);
    return `discarded brief ${describe(mine[0], now)}. /clear is a normal clear again.`;
  }
  const others = waitingHere(payload, ctx);
  const hint = others.length ? ` Waiting for this folder: ${others.map((record) => describe(record, now)).join(' · ')}. To drop one: /wash discard <id>.` : '';
  return `no brief is ready in this session, so there was nothing to discard.${hint}`;
}

// Make this terminal the owner of a brief, so its next /clear delivers it.
// Whatever it owned before goes back to waiting for its folder.
function adopt(record, payload, { env, now, me }) {
  for (const other of readyRecords(env, now)) {
    if (other.id !== record.id && sameProcess(other.owner, me)) updateRecord(env, { ...other, owner: null });
  }
  const owned = { ...record, owner: { pid: me.pid, start: me.start, sessionId: payload.session_id ?? null } };
  updateRecord(env, owned);
  return owned;
}

function load(payload, ref, ctx) {
  const { env, now } = ctx;
  let match;
  if (ref) {
    const found = findRecords(env, ref, now);
    if (found.length > 1) return `"${ref}" matches more than one brief: ${found.map(({ record }) => describe(record, now)).join(' · ')}. Nothing was loaded.`;
    if (!found.length) return `no brief has the id "${ref}". It may have expired: a brief is kept for 48 hours.`;
    [match] = found;
  } else {
    const others = waitingHere(payload, ctx);
    if (!others.length) return 'no briefs are waiting for this folder.';
    if (others.length > 1) return `more than one brief is waiting for this folder: ${others.map((record) => describe(record, now)).join(' · ')}. Pick one: /wash load <id>.`;
    match = { record: others[0], consumed: false };
  }
  const record = match.consumed ? reopen(env, match.record) : match.record;
  if (!record) return `brief ${match.record.id} could not be loaded: another session took it just now.`;
  const owned = adopt(record, payload, ctx);
  const elsewhere = owned.source?.worktree && owned.source.worktree !== worktreeRoot(cwdOf(payload)) ? ` Note: it was written in a different folder, ${owned.source.worktree}.` : '';
  return `brief ${describe(owned, now)} is ready ✓ Type /clear to start fresh with it.${elsewhere}`;
}

// --- Stop ----------------------------------------------------------------

function onStop(payload, ctx) {
  const { env, now, me } = ctx;
  const sessionId = payload.session_id;
  const wash = currentWash(env, sessionId, now);
  if (!wash) return null;

  // Claude Code gives a prompt and every Stop of its turn the same id. A Stop
  // for some other prompt means the wash turn ended without one of its own:
  // it was interrupted.
  if (wash.promptId && payload.prompt_id && wash.promptId !== payload.prompt_id) {
    endWash(env, sessionId);
    return null;
  }

  const reply = parseReply(payload.last_assistant_message);
  if (!reply) {
    endWash(env, sessionId);
    return { systemMessage: 'Carwash: that reply was not a brief, so nothing was saved. Run /wash again to retry.' };
  }

  const tokens = estimateTokens(reply.text);
  const overCap = Boolean(wash.cap) && tokens > wash.cap;
  if (overCap && wash.rewrites < MAX_REWRITES) {
    startWash(env, sessionId, { ...wash, rewrites: wash.rewrites + 1 });
    return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: retryNote(wash.level, wash.cap, tokens) } };
  }

  const cwd = cwdOf(payload);
  const record = addRecord(
    env,
    {
      level: wash.level,
      title: reply.title,
      tokens,
      cap: wash.cap,
      used: wash.used,
      overCap,
      source: { sessionId, transcriptPath: payload.transcript_path ?? null, cwd, ...repoState(cwd) },
      owner: { pid: me.pid, start: me.start, sessionId },
      brief: reply.text,
    },
    now,
  );
  // One ready brief per terminal. An earlier wash of this same session is out
  // of date and goes; anything else this terminal held goes back to waiting.
  for (const other of readyRecords(env, now)) {
    if (other.id === record.id) continue;
    if (other.source?.sessionId === sessionId) removeRecord(env, other.id);
    else if (sameProcess(other.owner, me)) updateRecord(env, { ...other, owner: null });
  }
  endWash(env, sessionId);
  return { systemMessage: readyMessage(record) };
}

// --- SessionStart --------------------------------------------------------

function deliver(record, payload, { env, now }) {
  // Another session may have taken it between the listing and now.
  if (!claim(env, record, payload.session_id, now)) return null;
  const stale = stalenessLine(record.source, repoState(cwdOf(payload)));
  return {
    systemMessage: loadedMessage(record, now, stale),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: composeContext(record, now, stale) },
  };
}

function onSessionStart(payload, ctx) {
  const { env, now, me } = ctx;
  // Only a brand-new conversation gets a brief; a resumed, compacted or
  // forked one already has its own history.
  if (payload.source !== 'startup' && payload.source !== 'clear') return null;
  if (unattended(env)) return null;
  purge(env, now);
  const ready = readyRecords(env, now);

  // Relaunched by Carwash's shell function for one particular brief.
  if (env.CARWASH_PENDING) {
    const named = ready.find((record) => record.id === env.CARWASH_PENDING);
    return named ? deliver(named, payload, ctx) : null;
  }
  if (!ready.length) return null;

  if (payload.source === 'clear') {
    // /clear keeps the process, so the brief this terminal asked for is the
    // one its process owns. Anything else leaves /clear a normal clear.
    const mine = ready.filter((record) => sameProcess(record.owner, me));
    return mine.length ? deliver(mine[0], payload, ctx) : null;
  }

  // A process that has only just started cannot own a brief yet: one carrying
  // its number was left by an earlier process that had the same pid.
  for (const record of ready) {
    if (record.owner?.pid === me.pid) {
      record.owner = null;
      updateRecord(env, record);
    }
  }

  // A new process picks up a brief left for its folder, but only when there is
  // no doubt which one is meant. Otherwise it says what is waiting and loads
  // nothing: the wrong context is worse than none.
  const here = worktreeRoot(cwdOf(payload));
  const waiting = ready.filter((record) => record.source?.worktree === here);
  if (!waiting.length) return null;
  let why = null;
  if (waiting.length > 1) why = 'there is more than one';
  else if (now - Date.parse(waiting[0].createdAt) > AUTO_LOAD_MS) why = 'it is over 12 hours old';
  else if (ctx.isRunning(waiting[0].owner)) why = 'the session that wrote it is still open';
  return why ? { systemMessage: pointerMessage(waiting, now, why) } : deliver(waiting[0], payload, ctx);
}

// --- entry point -----------------------------------------------------------

// Handle one hook call. `input` is the JSON Claude Code sends on stdin.
export function runHook({ input, env = process.env, platform = process.platform, now = Date.now(), me, running } = {}) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const ctx = {
    env,
    now,
    me: me ?? currentProcess(env, platform),
    isRunning: running ?? ((owner) => isRunning(owner, platform)),
  };
  switch (payload.hook_event_name) {
    case 'UserPromptExpansion':
      return onExpansion(payload, ctx);
    case 'Stop':
      return onStop(payload, ctx);
    case 'SessionStart':
      return onSessionStart(payload, ctx);
    default:
      return null;
  }
}
