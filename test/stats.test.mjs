import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { learnHabits, sessionShape, shareFor } from '../src/stats/habits.mjs';
import { heldLines, likelyOf, measure, readLedger, refreshLedger, totals } from '../src/stats/ledger.mjs';
import { describeShare, sendShare, shareId, sharePayload } from '../src/stats/report.mjs';
import { runHook } from '../src/wash/hooks.mjs';
import { saveUsage } from '../src/wash/session.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const ME = { pid: 1001, start: 'a' };

const BRIEF = `# Carwash brief: Fix login redirect

## Core
- Objective: stop the redirect loop after login.
- State: cause found; no fix written yet.
- Next: write a failing test.`;

// Transcript lines as Claude Code writes them.
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const request = (id, sent) => ({ type: 'assistant', message: { id, usage: { input_tokens: 2, cache_read_input_tokens: sent - 1002, cache_creation_input_tokens: 1000, output_tokens: 50 } } });
const jsonl = (lines) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

test('a fresh session is measured request by request against the old one', () => {
  const text = jsonl([
    prompt('fix the redirect'),
    request('m1', 20_000),
    request('m1', 20_000), // the same request written twice
    toolResult(),
    request('m2', 25_000),
    prompt('<bash-input>ls</bash-input>'), // a shell command, not a prompt
    { ...prompt('subagent'), isSidechain: true },
    { ...request('s1', 5_000), isSidechain: true },
    prompt('now the tests'),
    request('m3', 30_000),
  ]);
  // Each request saved the gap between the old session (100k) and where the fresh one started (20k).
  assert.deepEqual(measure(text, 100_000, 200_000), { prompts: 2, requests: 3, start: 20_000, saved: 240_000, turns: [[2, 0], [1, 0]] });

  // Counting stops where the old session would have compacted, at 90% of its
  // window: in a 120k window, 30k plus the 80k gap is 110k, over 108k.
  assert.deepEqual(measure(text, 100_000, 120_000), { prompts: 2, requests: 2, start: 20_000, saved: 160_000, turns: [[2, 0]] });

  // A compaction in the fresh session ends the comparison.
  const compacted = jsonl([prompt('a'), request('m1', 20_000), { type: 'system', subtype: 'compact_boundary' }, request('m2', 21_000)]);
  assert.equal(measure(compacted, 100_000, null).requests, 1);

  // No gap, no saving; an empty transcript, nothing at all.
  assert.deepEqual(measure(text, 15_000, null), { prompts: 0, requests: 0, start: 20_000, saved: 0, turns: [] });
  assert.deepEqual(measure('not json\n', 100_000, null), { prompts: 0, requests: 0, start: null, saved: 0, turns: [] });
});

const FILE = ['export function login(user) {', '  return redirectTo(user.home ?? "/dashboard");', '}'].join('\n');
const read = (id, text) => [
  { type: 'assistant', message: { id: `a-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'cat login.js' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } },
];

test('output the old session already had is not counted as saved', () => {
  // The old session read the file, then compacted it away and read it again.
  const old = jsonl([...read('t0', 'gone after compacting the old session'), { type: 'system', subtype: 'compact_boundary' }, ...read('t1', FILE)]);
  const held = heldLines(old);
  assert.ok(held.has('return redirectTo(user.home ?? "/dashboard");'));
  assert.ok(!held.has('gone after compacting the old session'));
  assert.ok(!held.has('}'), 'short lines are too common to match');

  // The fresh session prints the same file with line numbers, then two requests carry it.
  const fresh = jsonl([prompt('fix login'), request('m1', 20_000), ...read('t2', FILE.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')), request('m2', 21_000), request('m3', 22_000)]);
  const { turns, saved } = measure(fresh, 100_000, null, { held });
  assert.equal(saved, 3 * 80_000);
  const [[requests, reread]] = turns;
  assert.equal(requests, 3);
  // Two lines of about 40 and 46 characters, carried by the two requests after the read.
  assert.ok(reread > 2 * 20 && reread < 2 * 40, `reread ${reread}`);
  assert.deepEqual(measure(fresh, 100_000, null).turns, [[3, 0]]);
});

test('the likely saving counts the first share of the prompts', () => {
  const measured = { requests: 10, saved: 1000, turns: [[1, 0], [3, 0], [6, 0]] };
  assert.equal(likelyOf(measured, 1), 1000);
  // Two-thirds of three prompts: the first two.
  assert.equal(likelyOf(measured, 2 / 3), 400);
  // Half of three: the first, and half of the second.
  assert.equal(likelyOf(measured, 0.5), 250);
  // Output read again comes off each request that carried it.
  assert.equal(likelyOf({ ...measured, turns: [[1, 30], [3, 0], [6, 0]] }, 1 / 3), 70);
  // Measured before turns were kept: the share of the total.
  assert.equal(likelyOf({ requests: 10, saved: 1000 }, 0.5), 500);
  assert.equal(likelyOf(null, 0.5), 0);
});

test('the share is learned from how far past sessions went', () => {
  // With nothing to go on, it is the starting guess.
  assert.equal(shareFor([], 300_000, 6), 2 / 3);
  // Ten sessions that reached 300k and stopped at once pull it halfway to nothing.
  const stopped = Array.from({ length: 10 }, () => ({ sizes: [100_000, 300_000], compacted: false }));
  assert.equal(shareFor(stopped, 300_000, 6), 1 / 3);
  // Sessions that never got that big say nothing.
  assert.equal(shareFor(stopped, 400_000, 6), 2 / 3);
  // Ten that went on six prompts, or compacted, pull it up to all.
  const kept = Array.from({ length: 10 }, (_, i) => ({ sizes: [300_000, 1, 2, 3, 4, 5, 6], compacted: i % 2 === 0 }));
  assert.equal(shareFor(kept, 300_000, 6), (2 / 3 * 10 + 10) / 20);

  const shape = sessionShape(
    jsonl([
      prompt('a'), request('m1', 40_000), request('m2', 41_000),
      { ...prompt('subagent'), isSidechain: true }, { ...request('s1', 5_000), isSidechain: true },
      prompt('b'), toolResult(), request('m3', 60_000),
      prompt('<command-name>/wash</command-name>\n<command-args>mid</command-args>'),
      { type: 'system', subtype: 'compact_boundary' }, prompt('c'), request('m4', 9_000),
    ]),
  );
  assert.deepEqual(shape, { sizes: [40_000, 60_000], compacted: true, washed: true });
  assert.equal(sessionShape(jsonl([prompt('<command-name>/wash</command-name>\n<command-args>stats</command-args>')])).washed, false);
});

test('habits are learned from Claude Code transcripts, read once each', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'carwash-habits-')));
  const env = { CARWASH_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude') };
  assert.deepEqual(learnHabits(env, { now: NOW }), []);
  const dir = join(env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  const write = (name, lines, age) => {
    const file = join(dir, name);
    writeFileSync(file, jsonl(lines));
    utimesSync(file, (NOW - age) / 1000, (NOW - age) / 1000);
    return file;
  };
  const HOUR = 3_600_000;
  const done = write('a.jsonl', [prompt('a'), request('m1', 40_000), prompt('b'), request('m2', 50_000)], 2 * HOUR);
  write('washed.jsonl', [prompt('a'), request('m1', 40_000), prompt('<command-name>/wash</command-name>\n<command-args></command-args>')], 2 * HOUR);
  write('going.jsonl', [prompt('a'), request('m1', 40_000)], 60_000); // may still be going
  write('ancient.jsonl', [prompt('a'), request('m1', 40_000)], 200 * 24 * HOUR);
  writeFileSync(join(dir, 'sub', 'agent.jsonl'), jsonl([prompt('a'), request('m1', 40_000)]));
  assert.deepEqual(learnHabits(env, { now: NOW }).map((s) => s.sizes), [[40_000, 50_000]]);

  // Read once: a transcript that has not changed is not read again, and one Claude Code deleted is remembered.
  writeFileSync(done, 'garbled');
  utimesSync(done, (NOW - 2 * HOUR) / 1000, (NOW - 2 * HOUR) / 1000);
  assert.deepEqual(learnHabits(env, { now: NOW }).map((s) => s.sizes), [[40_000, 50_000]]);
  const cache = readFileSync(join(env.CARWASH_HOME, 'habits.json'), 'utf8');
  assert.ok(!cache.includes('fix') && !cache.includes('"a"'), 'only sizes are kept');
});

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'carwash-stats-')));
  const env = { CARWASH_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude') };
  const cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true });
  const hook = (payload, now = NOW) => runHook({ input: JSON.stringify({ cwd, ...payload }), env, now, me: ME, running: () => false });
  const wash = (level = 'mid', { session = 'S1', used = 100_000, reply = BRIEF } = {}) => {
    saveUsage(env, session, { used, size: 200_000 });
    hook({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: level, session_id: session, prompt_id: 'P1' });
    return hook({ hook_event_name: 'Stop', last_assistant_message: reply, session_id: session, prompt_id: 'P1' });
  };
  const transcript = (name, lines) => {
    const file = join(root, `${name}.jsonl`);
    writeFileSync(file, jsonl(lines));
    return file;
  };
  const clear = (session, file) => hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: session, transcript_path: file });
  return { root, env, hook, wash, transcript, clear };
}

test('washes and deliveries are kept in the ledger and totalled', () => {
  const { env, wash, transcript, clear } = sandbox();
  wash('mid');
  const file = transcript('S2', [prompt('go on'), request('m1', 20_000), prompt('and test it'), request('m2', 24_000)]);
  assert.match(clear('S2', file).systemMessage, /^Loaded your Carwash brief/);

  // A brief written but never used still counts what it cost.
  wash('light', { session: 'S3', used: 50_000 });

  // Both are written at the same moment, so find them by level, not order.
  const entries = readLedger(env);
  const first = entries.find((entry) => entry.level === 'mid');
  const second = entries.find((entry) => entry.level === 'light');
  assert.equal(first.level, 'mid');
  assert.equal(first.deliveries.length, 1);
  assert.equal(first.deliveries[0].transcript, file);
  assert.equal(second.deliveries.length, 0);

  const sum = totals(refreshLedger(env, { now: NOW, force: true }), NOW + 3 * 86_400_000);
  assert.equal(sum.washes, 2);
  assert.deepEqual(sum.levels, { mid: 1, light: 1 });
  assert.equal(sum.delivered, 1);
  assert.equal(sum.prompts, 2);
  assert.equal(sum.requests, 2);
  assert.equal(sum.notResent, 160_000);
  // One attempt each: the old session read once plus the brief written.
  const briefTokens = first.tokens + second.tokens;
  assert.equal(sum.briefCost, 150_000 + briefTokens);
  assert.equal(sum.days, 3);

  // The ledger outlives the briefs: none of it is in the brief store.
  assert.ok(readdirSync(join(env.CARWASH_HOME, 'stats')).every((name) => !readFileSync(join(env.CARWASH_HOME, 'stats', name), 'utf8').includes('redirect loop')));
});

test('a failing ledger never stops a brief from being saved or delivered', () => {
  const { env, wash, clear, root } = sandbox();
  mkdirSync(env.CARWASH_HOME, { recursive: true });
  writeFileSync(join(env.CARWASH_HOME, 'stats'), 'not a folder');
  assert.match(wash('mid').systemMessage, /^Brief ready/);
  assert.match(clear('S2', join(root, 'S2.jsonl')).systemMessage, /^Loaded your Carwash brief/);
});

test('/wash stats answers without reaching Claude', () => {
  const { hook, wash, transcript, clear } = sandbox();
  const stats = () => hook({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: 'stats', session_id: 'S9', prompt_id: 'P9' });
  assert.match(stats().reason, /^Carwash: Carwash stats: no briefs written yet/);
  assert.equal(stats().decision, 'block');

  wash('mid');
  clear('S2', transcript('S2', [prompt('go on'), request('m1', 20_000)]));
  const { reason } = stats();
  assert.match(reason, /Briefs written {14}1 {2}\(mid 1\)/);
  assert.match(reason, /Context not re-sent {9}~53.3k tokens {2}\(at most ~80k tokens\)/);
  assert.match(reason, /run in a terminal: npx context-carwash stats --share$/);
});

const sink = () => {
  const stream = new Writable({ write: (chunk, _enc, done) => ((stream.text += chunk), done()) });
  stream.text = '';
  return stream;
};

test('stats --share shows everything it sends, and sends only totals', async () => {
  const { env, wash, transcript, clear, root } = sandbox();
  const form = { action: 'https://example.test/formResponse', fields: Object.fromEntries(['shareId', 'version', 'system', 'days', 'washes', 'prompts', 'notResent', 'likely', 'briefCost'].map((key, i) => [key, `entry.${i}`])) };
  const run = async (args, { ready = form, accepted = true } = {}) => {
    const stdout = sink();
    const sent = [];
    const share = async (payload) => (sent.push(payload), accepted);
    const code = await main(['stats', ...args], { env, stdin: { isTTY: false }, stdout, stderr: sink(), form: ready, share });
    return { code, sent, out: stdout.text };
  };

  // Nothing to share yet.
  assert.deepEqual((await run(['--share', '--yes'])).sent, []);

  wash('mid');
  clear('S2', transcript('S2', [prompt('go on'), request('m1', 20_000)]));

  // Without the form set up, nothing goes anywhere.
  const off = await run(['--share', '--yes'], { ready: { action: null, fields: {} } });
  assert.equal(off.code, 1);
  assert.match(off.out, /Sharing is not switched on/);
  assert.deepEqual(off.sent, []);

  // Without a terminal to ask in, and no --yes, it refuses.
  assert.equal((await run(['--share'])).sent.length, 0);

  const yes = await run(['--share', '--yes']);
  assert.equal(yes.code, 0);
  assert.equal(yes.sent.length, 1);
  const [payload] = yes.sent;
  assert.deepEqual(Object.keys(payload), ['shareId', 'version', 'system', 'days', 'washes', 'prompts', 'notResent', 'likely', 'briefCost']);
  assert.equal(payload.notResent, 80_000);
  assert.equal(payload.likely, 53_333);
  assert.match(yes.out, /Sent\. Thank you\./);
  // Nothing from the machine or the work: no paths, no brief text.
  const flat = JSON.stringify(payload);
  assert.ok(!flat.includes(root) && !flat.includes('redirect'));
  // Every field sent is shown first.
  for (const value of Object.values(payload)) assert.ok(yes.out.includes(String(value)));

  // The share id stays the same from one share to the next.
  assert.equal((await run(['--share', '--yes'])).sent[0].shareId, payload.shareId);
  assert.equal(shareId(env), payload.shareId);

  const failed = await run(['--share', '--yes'], { accepted: false });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /Could not reach the form/);
});

test('a share is posted to the form as its own fields', async () => {
  const form = { action: 'https://example.test/formResponse', fields: { washes: 'entry.1', system: 'entry.2' } };
  const calls = [];
  const fetchImpl = async (url, options) => (calls.push([url, options]), { ok: true });
  assert.equal(await sendShare({ washes: 3, system: 'macOS' }, { form, fetchImpl }), true);
  const [[url, options]] = calls;
  assert.equal(url, form.action);
  assert.equal(options.method, 'POST');
  assert.equal(options.body.toString(), 'entry.1=3&entry.2=macOS');
  assert.equal(await sendShare({ washes: 3 }, { form, fetchImpl: async () => { throw new Error('offline'); } }), false);

  const sum = { days: 2, washes: 3, prompts: 9, notResent: 1000, briefCost: 10 };
  const payload = sharePayload(sum, { shareId: 'abc', version: '0.1.4', platform: 'darwin' });
  assert.equal(payload.system, 'macOS');
  assert.match(describeShare(payload), /Operating system {12}macOS/);
});
