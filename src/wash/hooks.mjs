import { existsSync, writeFileSync } from 'node:fs';
import { packageVersion } from '../install/install.mjs';
import { startNotice, versionLine } from '../install/notice.mjs';
import { isNewer } from '../install/update.mjs';
import { DEFAULT_LEVEL, capFor, estimateTokens, isLevel } from '../levels.mjs';
import { installRecordPath, welcomedPath } from '../paths.mjs';
import { recordDelivery, recordWash, refreshLedger, totals } from '../stats/ledger.mjs';
import { colorDepth } from '../statusline/color.mjs';
import { statsReport } from '../stats/report.mjs';
import { budgetNote, composeContext, describe, helpMessage, loadedMessage, parseReply, pointerMessage, readyMessage, replyMeterMessage, retryNote, stalenessLine, welcomeMessage } from './brief.mjs';
import { isTool, toolInfo, toolOf } from '../tools.mjs';
import { repoState, worktreeRoot } from './git.mjs';
import { codexProcess, codexUnattended, currentProcess, isRunning, sameProcess } from './process.mjs';
import { readCodexReplyUsage, readCodexUsage, readCodexVersion } from './rollout.mjs';
import { currentWash, endWash, loadUsage, startWash } from './session.mjs';
import { AUTO_LOAD_MS, addRecord, claim, findRecords, purge, readyRecords, removeRecord, reopen, updateRecord } from './store.mjs';

// Carwash's three hooks, in Claude Code and in Codex:
//
//   UserPromptExpansion  /wash was typed (Claude Code). In Codex, where $wash
//   UserPromptSubmit     is a skill, every prompt comes through
//                        UserPromptSubmit and only one starting with $wash is
//                        ours. A level starts a wash and tells the model the
//                        size limit; discard, load, stats and help are handled
//                        here and never reach the model.
//   Stop                 The model finished replying. If that reply is the
//                        brief, save it. Otherwise, in Codex, show the meter.
//   SessionStart         A session began. If a brief is meant for it, hand the
//                        brief over. The first one after install says hello.
//                        It also starts the daily update check, in the
//                        background, and passes on what the last one found.
//
// Each handler returns the JSON to print for the tool, or null to stay out of
// the way. None of them ever clears, restarts, or runs anything. Both tools
// read the same JSON fields here, apart from how a Stop asks for another try.

const usageLine = (tool) => {
  const wash = toolInfo(tool).wash;
  return `Usage: ${wash} [light | mid | detailed], ${wash} discard [id], ${wash} load [id], ${wash} stats, ${wash} help`;
};

// How many times to ask for a shorter brief before keeping an oversized one.
const MAX_REWRITES = 2;

// Stops the command before it reaches the model: no model turn, no cost.
// Claude Code shows the reason under "operation blocked by hook", Codex under
// "Blocked by hook", so it names us.
const block = (reason) => ({ decision: 'block', reason: `Carwash: ${reason}` });

// A `claude -p` run or other unattended session has nobody to carry on a
// conversation, so it must not use up a brief meant for a person.
const unattended = (env) => env.CLAUDE_CODE_SESSION_ATTENDED === '0' || /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? '');

// Claude Code gives each prompt an id that every Stop of its turn repeats;
// Codex does the same with its turn id.
const promptIdOf = (payload) => payload.prompt_id ?? payload.turn_id ?? null;

// The savings ledger is bookkeeping: if it fails, the brief still has to work.
function quietly(ctx, fn) {
  try {
    fn();
  } catch (error) {
    ctx.onError?.(error);
  }
}

// A question asked at most once per hook call.
const once = (ask) => {
  let answer;
  return () => (answer ??= ask());
};

const cwdOf = (payload) => (typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());

// --- /wash ---------------------------------------------------------------

function onExpansion(payload, ctx) {
  if (String(payload.command_name ?? '').replace(/^\//, '') !== 'wash') return null;
  return washCommand(payload, payload.command_args, 'UserPromptExpansion', ctx);
}

// Codex runs this for every prompt, so anything that is not $wash returns at
// once, before any file or process is looked at.
const DOLLAR_WASH = /^\s*\$wash(?![\w-])([\s\S]*)$/;

function onPromptSubmit(payload, ctx) {
  const found = typeof payload.prompt === 'string' ? DOLLAR_WASH.exec(payload.prompt) : null;
  return found ? washCommand(payload, found[1], 'UserPromptSubmit', ctx) : null;
}

function washCommand(payload, args, event, ctx) {
  const [verb = DEFAULT_LEVEL, ref] = String(args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (isLevel(verb)) return begin(payload, verb, event, ctx);
  if (verb === 'discard') return block(discard(payload, ref, ctx));
  if (verb === 'load') return block(load(payload, ref, ctx));
  if (verb === 'stats') return block(statsReport(totals(refreshLedger(ctx.env, { now: ctx.now, force: true }), ctx.now), { inClaude: true }));
  if (verb === 'help') return block(helpMessage(ctx.usage(payload)?.used ?? null, versionLine(ctx.version, ctx.env), ctx.tool));
  return block(`${toolInfo(ctx.tool).wash} does not know "${verb}". ${usageLine(ctx.tool)}`);
}

function begin(payload, level, event, ctx) {
  const { env, now } = ctx;
  const usage = ctx.usage(payload);
  const used = usage?.used ?? null;
  const cap = capFor(level, used);
  startWash(env, payload.session_id, { promptId: promptIdOf(payload), level, cap, used, size: usage?.size ?? null, startedAt: now, rewrites: 0 });
  return { hookSpecificOutput: { hookEventName: event, additionalContext: budgetNote(level, cap, used) } };
}

// Briefs waiting for the folder this session is in, other than its own. Only
// ones written in the same tool: a brief from the other one is used only when
// asked for by its id.
function waitingHere(payload, { env, now, me, tool }) {
  const here = worktreeRoot(cwdOf(payload));
  return readyRecords(env, now).filter((record) => record.source?.worktree === here && toolOf(record) === tool && !sameProcess(record.owner, me));
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
  const hint = others.length ? ` Waiting for this folder: ${others.map((record) => describe(record, now)).join(' · ')}. To drop one: ${toolInfo(ctx.tool).wash} discard <id>.` : '';
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
    if (others.length > 1) return `more than one brief is waiting for this folder: ${others.map((record) => describe(record, now)).join(' · ')}. Pick one: ${toolInfo(ctx.tool).wash} load <id>.`;
    match = { record: others[0], consumed: false };
  }
  const record = match.consumed ? reopen(env, match.record) : match.record;
  if (!record) return `brief ${match.record.id} could not be loaded: another session took it just now.`;
  const owned = adopt(record, payload, ctx);
  const elsewhere = owned.source?.worktree && owned.source.worktree !== worktreeRoot(cwdOf(payload)) ? ` Note: it was written in a different folder, ${owned.source.worktree}.` : '';
  return `brief ${describe(owned, now)} is ready ✓ ${toolInfo(ctx.tool).afterClear}${elsewhere}`;
}

// --- Stop ----------------------------------------------------------------

// Where the status line cannot show the meter (Codex), it follows each reply
// instead. It goes to the user only, never to the model, so it costs nothing.
function replyMeter(payload, ctx) {
  if (!toolInfo(ctx.tool).replyMeter) return null;
  const usage = ctx.replyUsage(payload);
  if (!usage) return null;
  const depth = codexShowsColor(ctx.codexVersion(payload)) ? colorDepth(ctx.env) : 'none';
  return { systemMessage: replyMeterMessage(usage, ctx.tool, depth) };
}

// Codex draws colour codes in a hook's message from 0.162.0 on (openai/codex
// #50359). Before that they would show as stray characters, so an unknown
// version gets plain text.
const COLOR_SINCE = '0.162.0';
const codexShowsColor = (version) => /^\d+\.\d+\.\d+$/.test(version ?? '') && !isNewer(COLOR_SINCE, version);

function onStop(payload, ctx) {
  const { env, now, me } = ctx;
  const sessionId = payload.session_id;
  const wash = currentWash(env, sessionId, now);
  if (!wash) return replyMeter(payload, ctx);

  // Claude Code gives a prompt and every Stop of its turn the same id, and
  // Codex its turn id, including the Stops after asking for a shorter brief. A
  // Stop for some other prompt means the wash turn ended without one of its
  // own: it was interrupted.
  const promptId = promptIdOf(payload);
  if (wash.promptId && promptId && wash.promptId !== promptId) {
    endWash(env, sessionId);
    return replyMeter(payload, ctx);
  }

  const reply = parseReply(payload.last_assistant_message);
  if (!reply) {
    endWash(env, sessionId);
    return { systemMessage: `Carwash: that reply was not a brief, so nothing was saved. Run ${toolInfo(ctx.tool).wash} again to retry.` };
  }

  const tokens = estimateTokens(reply.text);
  const overCap = Boolean(wash.cap) && tokens > wash.cap;
  if (overCap && wash.rewrites < MAX_REWRITES) {
    startWash(env, sessionId, { ...wash, rewrites: wash.rewrites + 1 });
    const note = retryNote(wash.level, wash.cap, tokens);
    // Codex continues the turn with a Stop's block reason as the next prompt.
    if (ctx.tool === 'codex') return { decision: 'block', reason: note };
    return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: note } };
  }

  const cwd = cwdOf(payload);
  const record = addRecord(
    env,
    {
      // Briefs from Claude Code carry no tool, as before Codex support.
      ...(ctx.tool === 'claude' ? {} : { tool: ctx.tool }),
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
  quietly(ctx, () => recordWash(env, record, wash));
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

function deliver(record, payload, ctx) {
  const { env, now } = ctx;
  // Another session may have taken it between the listing and now.
  if (!claim(env, record, payload.session_id, now)) return null;
  quietly(ctx, () => recordDelivery(env, record, payload, now, ctx.tool));
  const stale = stalenessLine(record.source, repoState(cwdOf(payload)));
  return {
    systemMessage: loadedMessage(record, now, stale, ctx.tool),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: composeContext(record, now, stale) },
  };
}

// The first session after install says what Carwash is, once. Creating the
// marker is the claim, so two sessions starting together cannot both say it.
// Uninstall deletes the marker with the rest of ~/.carwash, so a reinstall
// says it again. Without an install record there is nobody to welcome.
function welcome(ctx) {
  const { env, now, tool } = ctx;
  if (!existsSync(installRecordPath(env)) || existsSync(welcomedPath(env, tool))) return null;
  if (ctx.unattended()) return null;
  try {
    writeFileSync(welcomedPath(env, tool), `${new Date(now).toISOString()}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    // Already shown, or nowhere to note it: better silent than said every time.
    return null;
  }
  return { systemMessage: welcomeMessage(tool) };
}

function onSessionStart(payload, ctx) {
  // Only a brand-new conversation gets a brief; a resumed, compacted or
  // forked one already has its own history.
  if (payload.source !== 'startup' && payload.source !== 'clear') return null;
  // Claude Code says in its environment whether anyone is there. Codex has to
  // be asked through its command line, which on Windows takes a PowerShell
  // run, so it is asked only once a brief or the welcome is at stake.
  if (ctx.tool === 'claude' && ctx.unattended()) return null;
  // The welcome waits for a start that has nothing else to say.
  const result = briefAtStart(payload, ctx) ?? welcome(ctx);
  quietly(ctx, () => ctx.checkUpdates?.());
  let notice = null;
  quietly(ctx, () => (notice = startNotice(ctx.version, ctx.env)));
  if (!notice) return result;
  if (!result) return { systemMessage: notice };
  return { ...result, systemMessage: result.systemMessage ? `${result.systemMessage}\n\n${notice}` : notice };
}

function briefAtStart(payload, ctx) {
  const { env, now, me } = ctx;
  purge(env, now);
  quietly(ctx, () => refreshLedger(env, { now }));
  const ready = readyRecords(env, now);

  // Relaunched by Carwash's shell function for one particular brief.
  if (env.CARWASH_PENDING) {
    const named = ready.find((record) => record.id === env.CARWASH_PENDING);
    return named ? deliver(named, payload, ctx) : null;
  }
  if (!ready.length || ctx.unattended()) return null;

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
  // nothing: the wrong context is worse than none. A brief written in the other
  // tool is not picked up this way.
  const here = worktreeRoot(cwdOf(payload));
  const waiting = ready.filter((record) => record.source?.worktree === here && toolOf(record) === ctx.tool);
  if (!waiting.length) return null;
  let why = null;
  if (waiting.length > 1) why = 'there is more than one';
  else if (now - Date.parse(waiting[0].createdAt) > AUTO_LOAD_MS) why = 'it is over 12 hours old';
  else if (ctx.isRunning(waiting[0].owner)) why = 'the session that wrote it is still open';
  return why ? { systemMessage: pointerMessage(waiting, now, why, ctx.tool) } : deliver(waiting[0], payload, ctx);
}

// --- entry point -----------------------------------------------------------

// Handle one hook call. `input` is the JSON the tool sends on stdin, and
// `tool` says which tool that is: 'claude' (Claude Code) or 'codex'.
//
// `checkUpdates` starts the daily update check. Only the real command passes
// it, so tests never go online. `unattended` and `usage` stand in for asking
// the system, in tests.
export function runHook({ input, tool = 'claude', env = process.env, platform = process.platform, now = Date.now(), me, running, onError, checkUpdates, version = packageVersion(), unattended: isUnattended, usage, replyUsage } = {}) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !isTool(tool)) return null;
  const codex = tool === 'codex';
  const self = me ?? (codex ? codexProcess(platform) : currentProcess(env, platform));
  const ctx = {
    tool,
    env,
    now,
    me: self,
    isRunning: running ?? ((owner) => isRunning(owner, platform)),
    onError,
    checkUpdates,
    version,
    unattended: once(isUnattended ?? (() => (codex ? codexUnattended(self.args) : unattended(env)))),
    // How much context the session is using. Claude Code's status line notes
    // it as it draws the meter; Codex writes it into its session file.
    usage: usage ?? ((p) => (codex ? readCodexUsage(p.transcript_path) : loadUsage(env, p.session_id))),
    // The same once a reply has ended, waiting briefly for Codex to note it.
    replyUsage: replyUsage ?? ((p) => readCodexReplyUsage(p.transcript_path)),
    codexVersion: (p) => readCodexVersion(p.transcript_path),
  };
  switch (`${tool}:${payload.hook_event_name}`) {
    case 'claude:UserPromptExpansion':
      return onExpansion(payload, ctx);
    case 'codex:UserPromptSubmit':
      return onPromptSubmit(payload, ctx);
    case 'claude:Stop':
    case 'codex:Stop':
      return onStop(payload, ctx);
    case 'claude:SessionStart':
    case 'codex:SessionStart':
      return onSessionStart(payload, ctx);
    default:
      return null;
  }
}
