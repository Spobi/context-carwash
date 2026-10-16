import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexHooksCheck, isCarwashCodexHook } from '../src/install/codex.mjs';
import { doctorReport } from '../src/install/doctor.mjs';
import { applyInstall, applyUninstall, describeInstall, describeUninstall, isCarwashHook, planInstall, planUninstall } from '../src/install/install.mjs';
import { UserError } from '../src/install/settings.mjs';
import { measureCodex, readLedger, refreshLedger, totals } from '../src/stats/ledger.mjs';
import { statsReport } from '../src/stats/report.mjs';
import { replyMeterMessage } from '../src/wash/brief.mjs';
import { runHook } from '../src/wash/hooks.mjs';
import { codexProcess, codexSubcommand, codexUnattended, processInfo } from '../src/wash/process.mjs';
import { readCodexReplyUsage, readCodexUsage, readCodexVersion } from '../src/wash/rollout.mjs';
import { currentWash, saveUsage } from '../src/wash/session.mjs';
import { readyRecords } from '../src/wash/store.mjs';

// Carwash in Codex: $wash, the hooks that serve it, the installer's Codex
// half, and the session files Codex writes. Claude Code's side has its own
// tests, which run unchanged.

const BIN = fileURLToPath(new URL('../bin/carwash.mjs', import.meta.url));
const posix = process.platform !== 'win32';
const NOW = Date.parse('2026-10-15T12:00:00Z');
const HOUR = 3_600_000;

const BRIEF = `# Carwash brief: Fix login redirect

## Core
- Objective: stop the redirect loop after login.
- State: cause found in src/auth/session.js:42; no fix written yet.
- Next: write a failing test in test/auth.test.js.`;

const A = { pid: 2001, start: 'a' };
const B = { pid: 2002, start: 'b' };

// One line of a Codex session file.
const line = (type, payload) => JSON.stringify({ timestamp: '2026-10-15T12:00:00.000Z', type, payload });
const reading = (used, size = 258_400) => line('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: used, cached_input_tokens: 0, output_tokens: 10 }, model_context_window: size } });
const prompt = (text) => line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
const request = (used, id, thread = 'T1') => line('token_usage_record', { thread_id: thread, response_id: id, usage: { input_tokens: used, cached_input_tokens: 0, output_tokens: 10 } });

// A Carwash home, a project folder, a Codex session file, and helpers that
// play the part of Codex calling the hooks.
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'carwash-codex-')));
  const env = { CARWASH_HOME: join(root, 'home') };
  const cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true });
  const transcript = join(root, 'rollout.jsonl');
  writeFileSync(transcript, [line('session_meta', { id: 'T1' }), prompt('hello'), reading(90_000), reading(100_000)].join('\n') + '\n');
  const hook = (payload, { tool = 'codex', me = A, now = NOW, running = () => false, unattended = () => false } = {}) =>
    runHook({ input: JSON.stringify({ cwd, transcript_path: transcript, model: 'gpt-5.6', permission_mode: 'default', ...payload }), tool, env, now, me, running, unattended });
  const submit = (text, options = {}) => hook({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: options.session ?? 'S1', turn_id: options.turn ?? 'T-1' }, options);
  const stop = (message, options = {}) =>
    hook({ hook_event_name: 'Stop', last_assistant_message: message, stop_hook_active: options.again ?? false, session_id: options.session ?? 'S1', turn_id: options.turn ?? 'T-1' }, options);
  const start = (source, options = {}) => hook({ hook_event_name: 'SessionStart', source, session_id: options.session ?? 'S2' }, options);
  const wash = (args = 'light', options = {}) => {
    submit(`$wash ${args}`, options);
    return stop(options.reply ?? BRIEF, options);
  };
  return { root, env, cwd, transcript, hook, submit, stop, start, wash, ready: (now = NOW) => readyRecords(env, now) };
}

test('$wash is how Codex asks for a brief: the size limit comes from its session file', () => {
  const { env, submit } = sandbox();
  const result = submit('$wash mid focus on the failing test');
  assert.equal(result.decision, undefined);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(result.hookSpecificOutput.additionalContext, /^Carwash: level mid\. This session is using about 100k tokens, so the ceiling for this brief is 3000 tokens/);
  assert.deepEqual({ ...currentWash(env, 'S1', NOW), startedAt: 0 }, { promptId: 'T-1', level: 'mid', cap: 3000, used: 100_000, size: 258_400, startedAt: 0, rewrites: 0 });
  // No arguments means mid, and a line break is as good as a space.
  assert.match(submit('$wash').hookSpecificOutput.additionalContext, /level mid/);
  assert.match(submit('  $wash light\nkeep the test names').hookSpecificOutput.additionalContext, /level light/);
});

test('every other prompt passes straight through, without looking anything up', () => {
  const { env, submit } = sandbox();
  // Asking for the process would mean a `ps` run on every prompt.
  const untouchable = {
    get pid() {
      throw new Error('looked up the process');
    },
    get start() {
      throw new Error('looked up the process');
    },
  };
  for (const text of ['fix the bug', 'please $wash light', '$washing machine', '$wash-other mid', '/wash mid', '', undefined]) {
    assert.equal(submit(text, { me: untouchable }), null);
  }
  assert.equal(existsSync(env.CARWASH_HOME), false);
  // Claude Code's events mean nothing from Codex, and the other way round.
  const { hook } = sandbox();
  assert.equal(hook({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: 'mid', session_id: 'S1' }), null);
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: '$wash mid', session_id: 'S1' }, { tool: 'claude' }), null);
  assert.equal(hook({ hook_event_name: 'Stop', session_id: 'S1' }, { tool: 'gemini' }), null);
});

test("Codex's reply to $wash is saved as a Codex brief, with Codex's next step", () => {
  const { env, cwd, wash, ready } = sandbox();
  const result = wash('mid');
  assert.equal(
    result.systemMessage,
    'Brief ready ✓ mid ~61 of 3k cap. Type /clear, then send your next message (even just "continue"): the brief loads with it. This is not a normal clear: your brief carries over. Old session stays in /resume.',
  );
  const [record] = ready();
  assert.equal(record.tool, 'codex');
  assert.equal(record.used, 100_000);
  assert.deepEqual(record.owner, { pid: 2001, start: 'a', sessionId: 'S1' });
  assert.equal(record.source.cwd, cwd);
  assert.equal(currentWash(env, 'S1', NOW), null);
});

test('in Codex an over-long brief is sent back by blocking the Stop, in the same turn', () => {
  const { transcript, submit, stop, ready } = sandbox();
  writeFileSync(transcript, reading(2000) + '\n'); // light cap: 20 tokens
  submit('$wash light');
  const first = stop(BRIEF);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /about 61 tokens, over the 20-token ceiling for light\. Send it again shortened/);
  assert.equal(first.hookSpecificOutput, undefined);
  assert.equal(ready().length, 0);
  // Codex keeps the turn id for the retry and says it is one.
  const short = '# Carwash brief: Fix login\n\n## Core\n- Next: test/auth.test.js';
  assert.match(stop(short, { again: true }).systemMessage, /^Brief ready ✓ light ~18 of 20 cap\./);
  assert.equal(ready().length, 1);
});

test('after each ordinary Codex reply, the meter: shown to the user, never to the model', () => {
  const { transcript, stop, submit } = sandbox();
  // 100k of 258.4k: six of fifteen cells.
  const result = stop('Here is the fix.');
  assert.deepEqual(Object.keys(result), ['systemMessage']);
  assert.equal(result.systemMessage, 'session context ~100k  [██████░░░░░░░░░]  $wash to compress, then /clear');
  // From three quarters full it says so.
  writeFileSync(transcript, reading(200_000) + '\n');
  assert.equal(stop('Done.').systemMessage, 'session context ~200k  [████████████░░░]  getting full · $wash to compress, then /clear');
  // A wash that never got its reply (another prompt ended it) gets the meter too.
  submit('$wash light', { turn: 'T-1' });
  assert.match(stop('Something else.', { turn: 'T-2' }).systemMessage, /^session context ~200k/);
  // No reading yet: nothing to show.
  writeFileSync(transcript, prompt('hi') + '\n');
  assert.equal(stop('Hi.'), null);
});

test('Claude Code never gets the after-reply meter: its status line has the real one', () => {
  const { cwd, transcript, env } = sandbox();
  let asked = false;
  const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'C1', cwd, transcript_path: transcript, last_assistant_message: 'Done.' });
  const replyUsage = () => {
    asked = true;
    return { used: 100_000, size: 200_000 };
  };
  assert.equal(runHook({ input, tool: 'claude', env, now: NOW, me: B, running: () => false, replyUsage }), null);
  assert.equal(asked, false);
});

test('the after-reply meter is in colour where Codex can draw it, and plain text elsewhere', () => {
  const { root, cwd, env } = sandbox();
  const transcript = join(root, 'versioned.jsonl');
  const stopIn = (version, extraEnv = {}) => {
    writeFileSync(transcript, [line('session_meta', { id: 'T1', cli_version: version }), reading(200_000)].join('\n') + '\n');
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'S1', turn_id: 'T-1', cwd, transcript_path: transcript, last_assistant_message: 'Done.' });
    return runHook({ input, tool: 'codex', env: { ...env, ...extraEnv }, now: NOW, me: A, running: () => false }).systemMessage;
  };
  const plain = 'session context ~200k  [████████████░░░]  getting full · $wash to compress, then /clear';
  const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
  // 0.162.0 and later: each cell coloured, green to red, and so is "getting full".
  const colored = stopIn('0.162.1');
  assert.equal(strip(colored), plain);
  assert.equal(colored.match(/\x1b\[38;5;\d+m█\x1b\[39m/g).length, 12);
  assert.match(colored, /\x1b\[38;5;\d+mgetting full\x1b\[39m · \$wash/);
  assert.match(stopIn('0.163.0', { COLORTERM: 'truecolor' }), /^session context ~200k {2}\[\x1b\[38;2;\d+;\d+;\d+m█/);
  assert.notEqual(stopIn('0.162.0'), plain);
  // Older or unknown versions would show the codes as text; NO_COLOR is obeyed.
  assert.equal(stopIn('0.161.0'), plain);
  assert.equal(stopIn('0.163.0-alpha.1'), plain);
  assert.equal(stopIn(undefined), plain);
  assert.equal(stopIn('0.162.1', { NO_COLOR: '1' }), plain);
});

test("the Codex version comes from the session file's first line", () => {
  const { root } = sandbox();
  const file = join(root, 'meta.jsonl');
  writeFileSync(file, [line('session_meta', { id: 'T1', base_instructions: 'x'.repeat(200_000), cli_version: '0.162.1' }), reading(1000)].join('\n'));
  assert.equal(readCodexVersion(file), '0.162.1');
  writeFileSync(file, [reading(1000), line('session_meta', { cli_version: '0.162.1' })].join('\n'));
  assert.equal(readCodexVersion(file), null);
  writeFileSync(file, '{"half a li');
  assert.equal(readCodexVersion(file), null);
  assert.equal(readCodexVersion(join(root, 'missing.jsonl')), null);
  assert.equal(readCodexVersion(null), null);
});

test('the meter line without a known window size has no bar', () => {
  assert.equal(replyMeterMessage({ used: 42_000, size: null }), 'session context ~42k  $wash to compress, then /clear');
  assert.equal(replyMeterMessage({ used: 300_000, size: 258_400 }), 'session context ~300k  [███████████████]  getting full · $wash to compress, then /clear');
});

test("the meter waits briefly for the reply's own reading, then makes do with the last one", () => {
  const { root } = sandbox();
  const file = join(root, 'turn.jsonl');
  const reply = line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'done' }] } });
  // The reading already follows the reply: no waiting.
  let waits = 0;
  const wait = () => waits++;
  writeFileSync(file, [reading(10_000), reply, reading(12_000)].join('\n') + '\n');
  assert.deepEqual(readCodexReplyUsage(file, { wait }), { used: 12_000, size: 258_400 });
  assert.equal(waits, 0);
  // Not written yet: read again until it is.
  writeFileSync(file, [reading(10_000), reply].join('\n') + '\n');
  const arrives = () => {
    if (++waits === 2) writeFileSync(file, [reading(10_000), reply, reading(12_500)].join('\n') + '\n');
  };
  waits = 0;
  assert.deepEqual(readCodexReplyUsage(file, { wait: arrives }), { used: 12_500, size: 258_400 });
  assert.equal(waits, 2);
  // Never written: give up after the settle time with the earlier reading.
  writeFileSync(file, [reading(10_000), reply].join('\n') + '\n');
  waits = 0;
  assert.deepEqual(readCodexReplyUsage(file, { wait, settleMs: 100 }), { used: 10_000, size: 258_400 });
  assert.equal(waits, 4);
  // The reply as Codex also records it for the model counts the same.
  const response = line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] });
  writeFileSync(file, [reading(10_000), response].join('\n') + '\n');
  waits = 0;
  assert.deepEqual(readCodexReplyUsage(file, { wait, settleMs: 50 }), { used: 10_000, size: 258_400 });
  assert.equal(waits, 2);
  assert.equal(readCodexReplyUsage(join(root, 'missing.jsonl'), { wait }), null);
});

test('$wash then /clear and a message: the fresh Codex session starts with the brief', () => {
  const { wash, start, ready } = sandbox();
  wash('light');
  const result = start('clear', { now: NOW + 2 * 60_000 });
  // The meter after each reply counts Codex's baseline too, so that is said.
  assert.equal(
    result.systemMessage,
    "Loaded your Carwash brief (light ~61, 2m ago), down from ~100k in the old session. That size is the brief alone; the meter also counts Codex's own baseline.",
  );
  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(result.hookSpecificOutput.additionalContext, /^# Carwash handoff\n\nThe user ran \$wash in an earlier session/);
  assert.ok(result.hookSpecificOutput.additionalContext.endsWith(BRIEF));
  assert.equal(ready().length, 0);
  assert.equal(start('clear', { session: 'S3' }), null);
});

test('discard, load, stats, help and mistakes answer in Codex without a model turn', () => {
  const { submit, wash, ready, start } = sandbox();
  const help = submit('$wash help');
  assert.equal(help.decision, 'block');
  assert.match(help.reason, /^Carwash: \$wash compresses this conversation into a short brief\. Your next \/clear then starts a fresh session, and the brief loads with the first message you send there\./);
  assert.match(help.reason, /\$wash light {11}goal, where things stand, next step, up to 1k tokens/);
  assert.doesNotMatch(help.reason, /status line/);
  assert.match(help.reason, /ordinary Codex reply/);

  assert.match(submit('$wash nonsense').reason, /^Carwash: \$wash does not know "nonsense"\. Usage: \$wash \[light \| mid \| detailed\], \$wash discard \[id\]/);
  assert.match(submit('$wash stats').reason, /^Carwash: Carwash stats: no briefs written yet/);

  wash('light');
  assert.match(submit('$wash discard').reason, /discarded brief .*\/clear is a normal clear again\./);
  assert.equal(ready().length, 0);
  assert.match(submit('$wash load').reason, /no briefs are waiting for this folder/);

  // Left by a Codex session that has closed, then loaded from another.
  wash('light', { me: B });
  const [again] = ready();
  assert.equal(start('startup', { running: () => true }).systemMessage.includes(`$wash load ${again.id}, then /clear.`), true);
  assert.match(submit('$wash load').reason, new RegExp(`brief ${again.id} .* is ready ✓ Type /clear, then send your next message`));
});

test("a new session picks up only its own tool's brief; the other's is used when asked by id", () => {
  const { env, cwd, wash, start, ready, submit } = sandbox();
  // A Claude Code brief waiting for this folder.
  saveUsage(env, 'C1', { used: 100_000, size: 200_000 });
  runHook({ input: JSON.stringify({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: 'light', session_id: 'C1', prompt_id: 'P1', cwd }), env, now: NOW, me: B, running: () => false });
  runHook({ input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: BRIEF, session_id: 'C1', prompt_id: 'P1', cwd }), env, now: NOW, me: B, running: () => false });
  const [claude] = ready();
  assert.equal(claude.tool, undefined);

  // A new Codex session leaves it alone.
  assert.equal(start('startup', { me: { pid: 3001, start: 'x' } }), null);
  assert.equal(ready().length, 1);

  // A Codex brief is not picked up by a new Claude Code session either.
  wash('light');
  const claudeStart = runHook({ input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'C2', cwd }), env, now: NOW, me: { pid: 3002, start: 'y' }, running: () => false });
  assert.match(claudeStart.systemMessage, /Loaded your Carwash brief/);
  assert.equal(readyRecords(env, NOW).length, 1);
  assert.equal(readyRecords(env, NOW)[0].tool, 'codex');

  // Asked for by id, the Claude Code brief is delivered in Codex.
  assert.match(submit(`$wash load ${claude.id}`, { me: { pid: 3003, start: 'z' } }).reason, /is ready ✓/);
});

test('a scripted Codex run never uses up a brief', () => {
  const { wash, start, ready } = sandbox();
  wash('light', { me: B });
  assert.equal(start('startup', { me: { pid: 3001, start: 'x' }, unattended: () => true }), null);
  assert.equal(ready().length, 1);
  assert.match(start('startup', { me: { pid: 3001, start: 'x' } }).systemMessage, /Loaded your Carwash brief/);
});

test('a Codex session start asks whether a script is running only when something is at stake', () => {
  const { env, wash, start, ready } = sandbox();
  let asked = 0;
  const unattended = () => (asked++, false);
  // Nothing waiting and no install, so no welcome: no question.
  assert.equal(start('startup', { unattended }), null);
  assert.equal(start('clear', { unattended }), null);
  assert.equal(asked, 0);
  // The welcome is at stake once, then never again.
  mkdirSync(env.CARWASH_HOME, { recursive: true });
  writeFileSync(join(env.CARWASH_HOME, 'install.json'), '{}');
  assert.match(start('startup', { unattended }).systemMessage, /installed ✓/);
  assert.equal(start('startup', { unattended }), null);
  assert.equal(asked, 1);
  // A brief is waiting: asked once, however many times it is needed.
  wash('light', { me: B });
  assert.match(start('startup', { me: { pid: 3001, start: 'x' }, unattended }).systemMessage, /Loaded your Carwash brief/);
  assert.equal(asked, 2);
  assert.equal(ready().length, 0);
});

test('Codex and Claude Code each say hello once', () => {
  const { env, start } = sandbox();
  mkdirSync(env.CARWASH_HOME, { recursive: true });
  writeFileSync(join(env.CARWASH_HOME, 'install.json'), '{}');
  assert.match(start('startup').systemMessage, /^Context Carwash installed ✓ \(shown once\)\n {2}• After each reply: tokens in use, and how full the context is\n {2}• Getting full\? \$wash, then \/clear and send your next message/);
  assert.equal(start('startup'), null);
  const claude = runHook({ input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'C1', cwd: env.CARWASH_HOME }), env, now: NOW, me: B, running: () => false });
  assert.match(claude.systemMessage, /Status line: tokens in use/);
});

test('the Codex process is found past a shell, and only when asked for', () => {
  const calls = [];
  const lookup = (pid) => {
    calls.push(pid);
    if (pid === process.ppid) return { ppid: 4242, args: ['/bin/zsh', '-c', 'node carwash.mjs hook codex'] };
    if (pid === 4242) return { ppid: 1, args: ['/usr/local/bin/codex'] };
    return null;
  };
  const me = codexProcess('darwin', lookup);
  assert.deepEqual(calls, []);
  assert.equal(me.pid, 4242);
  assert.equal(me.pid, 4242);
  assert.deepEqual(me.args, ['/usr/local/bin/codex']);
  assert.deepEqual(calls, [process.ppid, 4242]);
  // A login shell's name starts with a dash.
  assert.equal(codexProcess('darwin', (pid) => (pid === process.ppid ? { ppid: 99, args: ['-zsh'] } : { ppid: 1, args: ['codex'] })).pid, 99);
  // Codex itself as the parent: nothing to skip.
  assert.equal(codexProcess('darwin', () => ({ ppid: 7, args: ['codex'] })).pid, process.ppid);
  // Nothing known (Windows): the parent.
  assert.equal(codexProcess('win32', () => null).pid, process.ppid);
});

test('a process and its parent can be read on this system', () => {
  // On Windows this runs the PowerShell lookup; elsewhere ps or /proc.
  const self = processInfo(process.pid);
  assert.ok(self, 'no answer about this process');
  assert.equal(self.ppid, process.ppid);
  assert.match(self.args[0], /node/i);
  assert.equal(processInfo(2 ** 22 + 12_345), null);
});

test('codex exec and codex review are scripts; everything else is a person', () => {
  assert.equal(codexSubcommand(['codex', 'exec', 'fix it']), 'exec');
  assert.equal(codexSubcommand(['codex', '-m', 'gpt-5.6', '-c', 'x=1', 'e', 'hi']), 'e');
  assert.equal(codexSubcommand(['codex', '--model=gpt-5.6', '--yolo', 'fix the bug']), 'fix the bug');
  assert.equal(codexSubcommand(['codex']), null);
  assert.equal(codexSubcommand(['codex', '--', 'exec']), null);
  assert.equal(codexSubcommand(undefined), null);
  assert.equal(codexUnattended(['codex', 'exec', 'hi']), true);
  assert.equal(codexUnattended(['codex', 'review']), true);
  assert.equal(codexUnattended(['codex', 'resume', '--last']), false);
  assert.equal(codexUnattended(['/opt/codex/bin/codex', 'app-server']), false);
  assert.equal(codexUnattended(null), false);
  // The command line of the Codex process past the shell is the one read.
  const lookup = (pid) => (pid === process.ppid ? { ppid: 77, args: ['C:\\Windows\\system32\\cmd.exe', '/C'] } : { ppid: 1, args: ['codex.exe', 'exec', 'go'] });
  const me = codexProcess('win32', lookup);
  assert.equal(me.pid, 77);
  assert.equal(codexUnattended(me.args), true);
});

test("Codex's session file gives the latest reading, from the end of the file", () => {
  const { root } = sandbox();
  const file = join(root, 'session.jsonl');
  const filler = line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(5000) }] });
  writeFileSync(file, [reading(10_000), filler, reading(42_000, 128_000), filler, line('event_msg', { type: 'token_count', info: null }), '{"half a li'].join('\n'));
  assert.deepEqual(readCodexUsage(file), { used: 42_000, size: 128_000 });
  // A reading too far back is not looked for.
  assert.equal(readCodexUsage(file, { tailBytes: 2000 }), null);
  assert.equal(readCodexUsage(join(root, 'missing.jsonl')), null);
  assert.equal(readCodexUsage(null), null);
  writeFileSync(file, prompt('hi') + '\n');
  assert.equal(readCodexUsage(file), null);
});

test('a fresh Codex session is measured request by request against the old one', () => {
  const text = [
    line('session_meta', { id: 'T1' }),
    prompt('continue'),
    request(15_000, 'r1'),
    request(15_000, 'r1'), // the same request written twice
    request(18_000, 'r2'),
    request(60_000, 'sub', 'T-sub'), // a subagent's
    prompt('now the tests'),
    request(21_000, 'r3'),
    line('compacted', { message: 'summary' }),
    request(5000, 'r4'),
  ].join('\n');
  assert.deepEqual(measureCodex(text, 100_000, 258_400), { prompts: 2, requests: 3, start: 15_000, saved: 3 * 85_000, turns: [[2, 0], [1, 0]] });
  // Older Codex: token_count events and user_message events.
  const older = [line('event_msg', { type: 'user_message', message: 'go' }), reading(20_000), reading(30_000)].join('\n');
  assert.deepEqual(measureCodex(older, 100_000, 258_400), { prompts: 1, requests: 2, start: 20_000, saved: 160_000, turns: [[2, 0]] });
  // Counting stops where the old session would have compacted on its own.
  assert.equal(measureCodex([reading(20_000), reading(150_000)].join('\n'), 100_000, 200_000).requests, 1);
  assert.deepEqual(measureCodex('', 100_000, 200_000), { prompts: 0, requests: 0, start: null, saved: 0, turns: [] });
});

test('the ledger reads each delivery with its own tool, and stats name the right model', () => {
  const { env, root, wash } = sandbox();
  wash('light');
  const fresh = join(root, 'fresh.jsonl');
  writeFileSync(fresh, [line('session_meta', { id: 'S2' }), prompt('continue'), request(16_000, 'r1', 'S2')].join('\n'));
  runHook({ input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'S2', cwd: join(root, 'project'), transcript_path: fresh }), tool: 'codex', env, now: NOW + HOUR, me: A, running: () => false, unattended: () => false });
  const [entry] = refreshLedger(env, { now: NOW + 2 * HOUR, force: true });
  assert.equal(entry.tool, 'codex');
  assert.equal(entry.deliveries[0].tool, 'codex');
  assert.deepEqual({ ...entry.deliveries[0].measured, mtime: 0, at: 0 }, { prompts: 1, requests: 1, start: 16_000, saved: 84_000, turns: [[1, 0]], method: 2, mtime: 0, at: 0 });
  const sum = totals(readLedger(env), NOW + 2 * HOUR);
  assert.deepEqual(sum.tools, ['codex']);
  const report = statsReport(sum);
  assert.match(report, /Prompts in fresh sessions {3}1 {2}\(1 requests to Codex\)/);
  assert.match(report, /every request to Codex carries the whole conversation/);
  assert.match(report, /Repeated context is cached and charged at about a tenth/);
  assert.match(statsReport({ ...sum, tools: ['claude', 'codex'] }), /requests to the model\)/);
  assert.match(statsReport({ ...sum, tools: undefined }), /requests to Claude\)[\s\S]*Claude caches repeated context/);
});

// --- install -------------------------------------------------------------

function machine({ claude = true, codex = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'carwash-codex-install-'));
  const env = { ...process.env, CARWASH_HOME: join(root, 'carwash'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), CARWASH_NO_UPDATE_CHECK: '1' };
  for (const key of ['COLUMNS', 'LINES', 'FORCE_HYPERLINK', 'TMUX', 'STY']) delete env[key];
  if (claude) mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  if (codex) mkdirSync(env.CODEX_HOME, { recursive: true });
  const hooksFile = join(env.CODEX_HOME, 'hooks.json');
  const skill = join(env.CODEX_HOME, 'skills', 'wash');
  return { root, env, hooksFile, skill, settings: join(env.CLAUDE_CONFIG_DIR, 'settings.json'), home: env.CARWASH_HOME };
}
const install = (env) => applyInstall(planInstall({ env }));
const uninstall = (env) => applyUninstall(planUninstall({ env }));
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const ours = (hooks) =>
  Object.entries(hooks ?? {}).flatMap(([event, groups]) => groups.filter((group) => group.hooks.some((hook) => isCarwashCodexHook(hook.command))).map((group) => [event, group.matcher ?? null]));

test('with Codex set up, install adds $wash to Codex beside Claude Code, and uninstall takes it all out', () => {
  const { env, hooksFile, skill, settings, home } = machine();
  const plan = planInstall({ env });
  const text = describeInstall(plan);
  assert.match(text, /2\. Claude Code: create .*settings\.json/);
  assert.match(text, /3\. Claude Code: add the \/wash command at /);
  assert.match(text, /4\. Codex: create .*hooks\.json\n {7}Adds three hooks, so \$wash can save a brief/);
  assert.match(text, /choose "Trust all and continue"/);
  assert.match(text, /5\. Codex: add the \$wash command at .*skills.wash/);
  assert.match(text, /an ordinary Claude or Codex reply/);
  install(env);

  const hooks = json(hooksFile).hooks;
  assert.deepEqual(ours(hooks), [['SessionStart', 'startup|clear'], ['UserPromptSubmit', null], ['Stop', null]]);
  assert.equal(hooks.SessionStart[0].hooks[0].additionalContextLimit, 0);
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].statusMessage, 'Context Carwash');
  assert.equal(hooks.Stop[0].hooks[0].timeout, 20);
  assert.match(hooks.Stop[0].hooks[0].command, /carwash\.mjs['"]? hook codex$/);
  // Claude Code's hooks are a different command, so neither uninstall can take the other's.
  assert.equal(isCarwashHook(hooks.Stop[0].hooks[0].command), false);
  assert.equal(isCarwashCodexHook(json(settings).hooks.Stop[0].hooks[0].command), false);
  assert.match(readFileSync(join(skill, 'SKILL.md'), 'utf8'), /^---\nname: wash\n[\s\S]*installed-by: context-carwash[\s\S]*The user typed \$wash/);
  assert.match(readFileSync(join(skill, 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  const record = json(join(home, 'install.json'));
  assert.deepEqual(record.tools, ['claude', 'codex']);
  assert.equal(record.codex.hadHooksFile, false);
  assert.ok(record.settingsPath);

  const undo = describeUninstall(planUninstall({ env }));
  assert.match(undo, /3\. Codex: delete .*hooks\.json \(Carwash created it/);
  assert.match(undo, /4\. Codex: remove the \$wash command at /);
  assert.match(undo, /5\. Delete /);
  uninstall(env);
  assert.equal(existsSync(hooksFile), false);
  assert.equal(existsSync(skill), false);
  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(home), false);
});

test("Codex's own hooks file comes back byte-for-byte, and edits made after install stay", () => {
  const original = '{\n    "hooks": {\n        "Stop": [{"hooks": [{"type": "command", "command": "notify-send done"}]}]\n    }\n}\n';
  const { env, hooksFile } = machine();
  writeFileSync(hooksFile, original);
  install(env);
  const hooks = json(hooksFile).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, 'notify-send done');
  // Ours go after theirs.
  assert.deepEqual(ours(hooks), [['Stop', null], ['SessionStart', 'startup|clear'], ['UserPromptSubmit', null]]);
  assert.equal(hooks.Stop.length, 2);
  assert.match(readFileSync(hooksFile, 'utf8'), /^\{\n {4}"hooks"/);
  // Installing again changes nothing more and still restores the true original.
  install(env);
  assert.equal(ours(json(hooksFile).hooks).length, 3);
  assert.match(describeUninstall(planUninstall({ env })), /Codex: restore .*hooks\.json to exactly what it was/);
  uninstall(env);
  assert.equal(readFileSync(hooksFile, 'utf8'), original);

  // Edited after install: only Carwash's hooks come out.
  install(env);
  const edited = json(hooksFile);
  edited.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }];
  writeFileSync(hooksFile, JSON.stringify(edited, null, 2));
  assert.match(describeUninstall(planUninstall({ env })), /Codex: edit .*hooks\.json: take out Carwash's hooks/);
  uninstall(env);
  assert.deepEqual(json(hooksFile), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } });
});

test('Codex alone: Claude Code is not touched; neither tool: Claude Code, as before', () => {
  const only = machine({ claude: false });
  const text = describeInstall(planInstall({ env: only.env }));
  assert.doesNotMatch(text, /Claude Code|settings\.json|\/wash command/);
  assert.match(text, /2\. Codex: create .*hooks\.json[\s\S]*3\. Codex: add the \$wash command/);
  assert.match(text, /an ordinary Codex reply/);
  install(only.env);
  assert.equal(existsSync(only.env.CLAUDE_CONFIG_DIR), false);
  assert.deepEqual(json(join(only.home, 'install.json')).tools, ['codex']);
  assert.equal(json(join(only.home, 'install.json')).settingsPath, undefined);
  const undo = describeUninstall(planUninstall({ env: only.env }));
  assert.doesNotMatch(undo, /settings\.json|\/wash command/);
  assert.match(undo, /1\. Codex: delete [\s\S]*2\. Codex: remove [\s\S]*3\. Delete /);
  uninstall(only.env);
  assert.equal(existsSync(only.hooksFile), false);
  assert.equal(existsSync(only.env.CLAUDE_CONFIG_DIR), false);

  const neither = machine({ claude: false, codex: false });
  const plan = planInstall({ env: neither.env });
  assert.equal(plan.claude, true);
  assert.equal(plan.codex, null);
  assert.doesNotMatch(describeInstall(plan), /Codex/);
  install(neither.env);
  assert.equal(existsSync(neither.hooksFile), false);
  assert.equal(json(join(neither.home, 'install.json')).tools, undefined);
});

test('a Claude Code install from before Codex support gains Codex on the next install', () => {
  const { env, hooksFile, settings, home } = machine({ codex: false });
  install(env);
  const before = json(join(home, 'install.json'));
  assert.equal(before.tools, undefined);
  mkdirSync(env.CODEX_HOME);
  const text = describeInstall(planInstall({ env }));
  assert.match(text, /The Carwash status line is already there/);
  assert.match(text, /4\. Codex: create/);
  install(env);
  const after = json(join(home, 'install.json'));
  assert.deepEqual(after.tools, ['claude', 'codex']);
  assert.equal(after.originalSha256, before.originalSha256);
  assert.equal(after.installedAt, before.installedAt);
  uninstall(env);
  assert.equal(existsSync(hooksFile), false);
  assert.equal(existsSync(settings), false);
});

test('Codex files Carwash cannot safely use are refused, with nothing changed', () => {
  const taken = machine();
  mkdirSync(taken.skill, { recursive: true });
  writeFileSync(join(taken.skill, 'SKILL.md'), '---\nname: wash\ndescription: mine\n---\nWash the car.');
  assert.throws(() => planInstall({ env: taken.env }), (error) => error instanceof UserError && /already have a Codex skill called wash/.test(error.message));
  assert.equal(existsSync(taken.home), false);

  for (const text of ['{ not json', '[]', '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
    const bad = machine();
    writeFileSync(bad.hooksFile, text);
    assert.throws(() => planInstall({ env: bad.env }), UserError);
    assert.equal(readFileSync(bad.hooksFile, 'utf8'), text);
  }

  // Someone else's wash skill is left alone by uninstall too.
  const { env, skill } = machine();
  install(env);
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: wash\n---\nmine now');
  uninstall(env);
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), '---\nname: wash\n---\nmine now');
});

test('install notes hooks in config.toml, but not the approvals Codex keeps there', () => {
  const { env } = machine();
  writeFileSync(join(env.CODEX_HOME, 'config.toml'), 'model = "gpt-5.6"\n\n[hooks.state."/x/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:1"\n');
  assert.doesNotMatch(describeInstall(planInstall({ env })), /hooks in config\.toml/);
  writeFileSync(join(env.CODEX_HOME, 'config.toml'), 'model = "gpt-5.6"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "x"\n');
  assert.match(describeInstall(planInstall({ env })), /You also have hooks in config\.toml/);
});

test('doctor checks the Codex hooks, whether Codex trusts them, and $wash', () => {
  const { env, hooksFile } = machine();
  install(env);
  let report = doctorReport({ env, running: '0.2.1', newest: null, claude: null, codex: 'codex-cli 0.162.1' });
  assert.match(report, /Codex {13}codex-cli 0\.162\.1/);
  assert.match(report, /Codex hooks {7}SessionStart ok · UserPromptSubmit ok · Stop ok/);
  assert.match(report, /Codex trust {7}not yet: start Codex and choose "Trust all and continue"/);
  assert.match(report, /\$wash command {5}ok/);
  assert.match(report, /Status line {7}ok/);

  // Codex keys each approval by file, event, and place in the file.
  const state = ['session_start', 'user_prompt_submit', 'stop'].map((event) => `[hooks.state."${hooksFile}:${event}:0:0"]\ntrusted_hash = "sha256:x"\n`).join('\n');
  writeFileSync(join(env.CODEX_HOME, 'config.toml'), state);
  assert.deepEqual(codexHooksCheck(env).trusted, { SessionStart: true, UserPromptSubmit: true, Stop: true });
  report = doctorReport({ env, running: '0.2.1', newest: null, claude: null, codex: null });
  assert.match(report, /Codex trust {7}ok/);
  assert.match(report, /Codex {13}not found on PATH/);

  writeFileSync(hooksFile, '{"hooks": {}}');
  report = doctorReport({ env, running: '0.2.1', newest: null, claude: null, codex: null });
  assert.match(report, /Codex hooks {7}SessionStart MISSING · UserPromptSubmit MISSING · Stop MISSING/);
  assert.doesNotMatch(report, /Codex trust/);

  // Without Codex anywhere, doctor does not mention it.
  const plain = machine({ codex: false });
  install(plain.env);
  assert.doesNotMatch(doctorReport({ env: plain.env, running: '0.2.1', newest: null, claude: null }), /Codex|\$wash/);
});

test('command line: install covers Codex, and the installed Codex hook runs as Codex runs it', () => {
  const { env, hooksFile, home } = machine();
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' }, input: '' });
  const result = run('install', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Installed\.\n {2}Claude Code: start a new session to get the meter and \/wash\. Its first message explains them\.\n {2}Codex: start a new session and choose "Trust all and continue"/);

  const command = json(hooksFile).hooks.UserPromptSubmit[0].hooks[0].command;
  const call = (payload) =>
    posix
      ? spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', input: JSON.stringify(payload), env })
      : spawnSync(process.execPath, [join(home, 'app', 'bin', 'carwash.mjs'), 'hook', 'codex'], { encoding: 'utf8', input: JSON.stringify(payload), env });
  const plain = call({ hook_event_name: 'UserPromptSubmit', session_id: 'S1', turn_id: 'T1', prompt: 'fix the bug', cwd: home });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout + plain.stderr, '');
  const help = call({ hook_event_name: 'UserPromptSubmit', session_id: 'S1', turn_id: 'T1', prompt: '$wash help', cwd: home });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(JSON.parse(help.stdout).decision, 'block');
  assert.match(JSON.parse(help.stdout).reason, /^Carwash: \$wash compresses/);
  // A Stop with nothing to do prints nothing: Codex wants JSON or silence.
  assert.equal(call({ hook_event_name: 'Stop', session_id: 'S1', turn_id: 'T1', last_assistant_message: 'done', cwd: home }).stdout, '');

  assert.equal(run('uninstall', '--yes').status, 0);
  assert.equal(existsSync(hooksFile), false);
  assert.deepEqual(readdirSync(env.CODEX_HOME).filter((name) => name !== 'skills'), []);
});
