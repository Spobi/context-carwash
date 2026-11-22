import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cacheTimerRow } from '../src/install/doctor.mjs';
import { CHECK_GAP_MS, SAFETY_MS, cacheTimer, checkCache, readCache, readChecks, requestTtl } from '../src/statusline/cache.mjs';
import { cacheSegment, render } from '../src/statusline/render.mjs';
import { statusline } from '../src/statusline/run.mjs';
import { visibleWidth } from '../src/statusline/terminal.mjs';
import { helpMessage, whatsNewMessage } from '../src/wash/brief.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const MODEL = 'claude-opus-5-5';

// Session-file entries shaped like Claude Code 2.1.330 writes them.
const breakpoints = (ttl) => [
  { path: ['system', 1], value: { type: 'ephemeral', ttl, scope: 'global' } },
  { path: ['messages', 3, 'content', 0], value: { type: 'ephemeral', ttl } },
];
const request = (id, at, { model = MODEL, ttl = '1h', cacheControl = breakpoints(ttl) } = {}) => ({
  type: 'api-request',
  sessionId: 's',
  id,
  timestamp: iso(at),
  querySource: 'repl_main_thread',
  params: { model, betas: ['x'] },
  cacheControl,
});
const user = (uuid, at, parentUuid = null) => ({ type: 'user', uuid, parentUuid, isSidechain: false, timestamp: iso(at), message: { role: 'user', content: 'go on' } });
const reply = (uuid, at, { ref = null, parentUuid = null, msgId = `msg-${uuid}`, model = MODEL, read = 100_000, written = 2_000, input = 2, w5 = 0, w1 = written, asked = '1h', ...extra } = {}) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  isSidechain: false,
  timestamp: iso(at),
  ...(ref ? { requestRef: ref } : {}),
  ...(asked ? { promptCacheRequested: asked } : {}),
  message: {
    id: msgId,
    model,
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: written, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: 300 },
  },
  ...extra,
});
const failed = (uuid, at) => ({
  type: 'assistant',
  uuid,
  isSidechain: false,
  isApiErrorMessage: true,
  error: 'rate_limit',
  timestamp: iso(at),
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});
const compact = (at) => ({ type: 'system', subtype: 'compact_boundary', parentUuid: null, isSidechain: false, content: 'Conversation compacted', timestamp: iso(at), uuid: `c${at}` });

const dir = () => mkdtempSync(join(tmpdir(), 'carwash-cache-'));
function transcript(entries, tail = '') {
  const file = join(dir(), 'session.jsonl');
  writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n' + tail);
  return file;
}
// The usual shape: a prompt, the request it sent, a reply in two entries.
const turn = (n, at, { replyAfter = 90_000, ...options } = {}) => [
  user(`u${n}`, at),
  request(`r${n}`, at + 20, options),
  reply(`a${n}`, at + replyAfter, { ref: `r${n}`, parentUuid: `u${n}`, msgId: `m${n}`, ...options }),
  reply(`a${n}b`, at + replyAfter + 500, { ref: `r${n}`, parentUuid: `a${n}`, msgId: `m${n}`, ...options }),
];

test('the clock starts when the request was sent, not when the reply came', () => {
  const found = readCache(transcript(turn(1, T0, { replyAfter: 4 * MIN })));
  assert.equal(found.at, T0 + 20);
  assert.equal(found.ttlMs, HOUR);
  assert.equal(found.model, MODEL);
  assert.equal(found.method, 'requests');
  assert.equal(found.cached, 102_000);
  assert.equal(found.key, 'r1');
});

test('a request still waiting for its reply is not counted', () => {
  const found = readCache(transcript([...turn(1, T0), user('u2', T0 + 5 * MIN), request('r2', T0 + 5 * MIN)]));
  assert.equal(found.key, 'r1');
});

test('failed, cancelled and subagent requests are not counted', () => {
  const found = readCache(
    transcript([
      ...turn(1, T0),
      user('u2', T0 + 5 * MIN),
      request('r2', T0 + 5 * MIN),
      failed('e2', T0 + 5 * MIN + 1000),
      user('u3', T0 + 6 * MIN),
      request('r3', T0 + 6 * MIN),
      reply('a3', T0 + 6 * MIN + 2000, { ref: 'r3', read: 0, written: 0, input: 0 }),
      reply('s1', T0 + 7 * MIN, { isSidechain: true, ref: 'r9' }),
      reply('s2', T0 + 7 * MIN, { agentId: 'agent-1' }),
    ]),
  );
  assert.equal(found.key, 'r1');
});

test('five-minute, one-hour and mixed caches', () => {
  const ttl = (options) => readCache(transcript(turn(1, T0, options))).ttlMs / MIN;
  assert.equal(ttl({ ttl: '1h' }), 60);
  assert.equal(ttl({ ttl: '5m', asked: '5m', w5: 2000, w1: 0 }), 5);
  // Mixed breakpoints: the shorter one decides.
  assert.equal(ttl({ cacheControl: [...breakpoints('1h'), { path: ['messages', 9], value: { type: 'ephemeral', ttl: '5m' } }] }), 5);
  // Asked for an hour but written for five minutes: five minutes.
  assert.equal(ttl({ ttl: '1h', w5: 500, w1: 1500 }), 5);
  // The request says nothing: the reply's own record of what was asked.
  assert.equal(ttl({ cacheControl: [], asked: '1h' }), 60);
  assert.equal(ttl({ cacheControl: [], asked: null, w1: 0, written: 0 }), 5);
  // A breakpoint with no ttl gets the API's default.
  assert.equal(requestTtl([{ value: { type: 'ephemeral' } }]), '5m');
  assert.equal(requestTtl([{ value: { type: 'ephemeral', ttl: '2h' } }]), '5m');
  assert.equal(requestTtl(null), null);
  // The lifetime can change partway through a session; the last request counts.
  const found = readCache(transcript([...turn(1, T0, { ttl: '1h' }), ...turn(2, T0 + 10 * MIN, { ttl: '5m', asked: '5m', w5: 2000, w1: 0 })]));
  assert.equal(found.ttlMs, 5 * MIN);
});

test('after /compact there is nothing to time until the next reply', () => {
  assert.equal(readCache(transcript([...turn(1, T0), compact(T0 + 10 * MIN)])), null);
  const found = readCache(transcript([...turn(1, T0), compact(T0 + 10 * MIN), ...turn(2, T0 + 11 * MIN)]));
  assert.equal(found.key, 'r2');
  // Text that merely mentions a compaction is not one.
  assert.equal(readCache(transcript([...turn(1, T0), user('u9', T0 + 12 * MIN, 'a1b')].map((e) => (e.uuid === 'u9' ? { ...e, message: { role: 'user', content: '"compact_boundary"' } } : e)))).key, 'r1');
});

test('a huge line after the reply, or between request and reply, is read past', () => {
  const huge = { type: 'user', uuid: 'big', isSidechain: false, timestamp: iso(T0 + 2 * MIN), toolUseResult: { stdout: 'x'.repeat(1_500_000) } };
  assert.equal(readCache(transcript([...turn(1, T0), huge])).key, 'r1');
  const [u, r, a, b] = turn(1, T0);
  assert.equal(readCache(transcript([u, r, huge, a, b])).key, 'r1');
  // Never more than the limit: past it, no timer rather than a guess.
  assert.equal(readCache(transcript([...turn(1, T0), huge]), { maxBytes: 512 * 1024 }), null);
});

test('a half-written last line is skipped', () => {
  const found = readCache(transcript(turn(1, T0), '{"type":"assistant","uuid":"a2","message":{"usage":{"cache_read'));
  assert.equal(found.key, 'r1');
});

test('an older Claude Code with no request records is timed from what the reply answered', () => {
  const entries = [
    user('u1', T0),
    reply('a1', T0 + 30_000, { parentUuid: 'u1', msgId: 'm1' }),
    reply('a1b', T0 + 40_000, { parentUuid: 'a1', msgId: 'm1' }),
  ];
  const found = readCache(transcript(entries));
  assert.equal(found.method, 'replies');
  assert.equal(found.at, T0);
  assert.equal(found.ttlMs, HOUR);
  assert.equal(readCache(transcript(entries.map((e) => (e.type === 'assistant' ? { ...e, promptCacheRequested: undefined, message: { ...e.message, usage: { ...e.message.usage, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 } } } } : e)))).ttlMs, 5 * MIN);
  // What the reply answered is not in the file: no timer.
  assert.equal(readCache(transcript(entries.slice(1))), null);
});

test('no timer without caching, a reply, or a readable file', () => {
  assert.equal(readCache(transcript(turn(1, T0, { read: 0, written: 0, input: 90_000 }))), null);
  assert.equal(readCache(transcript([user('u1', T0)])), null);
  assert.equal(readCache(transcript([])), null);
  assert.equal(readCache(join(dir(), 'missing.jsonl')), null);
  assert.equal(readCache(transcript(['not json', '{"type":"assistant"'])), null);
});

const home = () => ({ CARWASH_HOME: dir() });
const payloadFor = (file, model = MODEL) => ({ session_id: 'sess-1', transcript_path: file, model: { id: model, display_name: 'Opus 5.5' } });

test('the timer counts down from the request, less the safety margin', () => {
  const env = home();
  const file = transcript(turn(1, T0));
  const at = T0 + 20;
  assert.deepEqual(cacheTimer(payloadFor(file), { env, now: at + 18 * MIN }), { leftMs: HOUR - 18 * MIN - SAFETY_MS, ttlMs: HOUR });
  assert.ok(cacheTimer(payloadFor(file), { env, now: at + HOUR - 5_000 }).leftMs < 0);
  // A clock that went backwards never shows more than a whole lifetime.
  assert.equal(cacheTimer(payloadFor(file), { env, now: at - 10 * MIN }).leftMs, HOUR - SAFETY_MS);
  // No session file, or none named: nothing.
  assert.equal(cacheTimer({ session_id: 'x' }, { env, now: at }), null);
  assert.equal(cacheTimer(null, { env, now: at }), null);
  assert.equal(cacheTimer(payloadFor(join(dir(), 'gone.jsonl')), { env, now: at }), null);
});

test('after a model switch the cache shows as expired at once; a context-size tag is not a switch', () => {
  const env = home();
  const file = transcript(turn(1, T0));
  const now = T0 + 5 * MIN;
  assert.equal(cacheTimer(payloadFor(file, 'claude-sonnet-5-5'), { env, now }).leftMs, 0);
  assert.ok(cacheTimer(payloadFor(file, 'claude-opus-5-5[1m]'), { env, now }).leftMs > 50 * MIN);
  // Back on the first model within the hour: its cache is still there.
  assert.ok(cacheTimer(payloadFor(file), { env, now }).leftMs > 50 * MIN);
  // A payload without a model is taken at its word.
  assert.ok(cacheTimer({ session_id: 'sess-1', transcript_path: file }, { env, now }).leftMs > 50 * MIN);
});

test('CARWASH_NO_CACHE_TIMER turns it off', () => {
  const file = transcript(turn(1, T0));
  assert.equal(cacheTimer(payloadFor(file), { env: { ...home(), CARWASH_NO_CACHE_TIMER: '1' }, now: T0 }), null);
  assert.ok(cacheTimer(payloadFor(file), { env: { ...home(), CARWASH_NO_CACHE_TIMER: '0' }, now: T0 }));
});

test('redraws while nothing changed do not read the file again', () => {
  const env = home();
  const file = transcript(turn(1, T0));
  let reads = 0;
  const read = (f) => {
    reads += 1;
    return readCache(f);
  };
  for (let i = 0; i < 5; i++) cacheTimer(payloadFor(file), { env, now: T0 + i * 5000, read });
  assert.equal(reads, 1);
  appendFileSync(file, JSON.stringify(user('u2', T0 + MIN)) + '\n');
  cacheTimer(payloadFor(file), { env, now: T0 + MIN, read });
  assert.equal(reads, 2);
});

const seen = (key, at, extra = {}) => ({ key, at, ttlMs: HOUR, model: MODEL, method: 'requests', cached: 100_000, read: 99_000, compactAt: null, ...extra });

test('the self-check counts pauses the timer called warm, and the misses', () => {
  const env = home();
  checkCache(env, seen('r1', T0), seen('r2', T0 + 20 * MIN, { read: 101_000 }));
  assert.deepEqual({ ...readChecks(env) }, { method: 'requests', checked: 1 });
  checkCache(env, seen('r2', T0 + 20 * MIN), seen('r3', T0 + 50 * MIN, { read: 0, cached: 103_000 }), T0 + 51 * MIN);
  const checks = readChecks(env);
  assert.equal(checks.checked, 2);
  assert.equal(checks.missed, 1);
  assert.deepEqual(checks.misses, [{ at: iso(T0 + 51 * MIN), pausedMin: 30, ttlMin: 60, expected: 100_000, read: 0 }]);
});

test('the self-check leaves out what says nothing about the timer', () => {
  const env = home();
  const skip = (before, after) => {
    checkCache(env, before, after);
    assert.equal(readChecks(env).checked, undefined);
  };
  // Steps of one turn, and the same reply seen twice.
  skip(seen('r1', T0), seen('r2', T0 + CHECK_GAP_MS - 1, { read: 0 }));
  skip(seen('r1', T0), seen('r1', T0, { read: 0 }));
  // A pause the timer already called expired.
  skip(seen('r1', T0), seen('r2', T0 + HOUR, { read: 0 }));
  // Another model, or a compaction in between.
  skip(seen('r1', T0), seen('r2', T0 + 10 * MIN, { model: 'claude-sonnet-5-5', read: 0 }));
  skip(seen('r1', T0), seen('r2', T0 + 10 * MIN, { compactAt: T0 + 5 * MIN, read: 0 }));
  // Nothing seen before.
  skip(null, seen('r2', T0 + 10 * MIN, { read: 0 }));
  assert.equal(readChecks(env).method, 'requests');
});

test('the self-check runs as the status line sees a new reply', () => {
  const env = home();
  const file = transcript(turn(1, T0));
  cacheTimer(payloadFor(file), { env, now: T0 + MIN });
  appendFileSync(file, turn(2, T0 + 25 * MIN, { read: 0, written: 103_000 }).map((e) => JSON.stringify(e)).join('\n') + '\n');
  cacheTimer(payloadFor(file), { env, now: T0 + 27 * MIN });
  assert.equal(readChecks(env).checked, 1);
  assert.equal(readChecks(env).missed, 1);
});

test('doctor says how the timer reads and how its checks went', () => {
  const env = home();
  assert.equal(cacheTimerRow(env), 'on, not shown yet');
  assert.equal(cacheTimerRow({ ...env, CARWASH_NO_CACHE_TIMER: '1' }), 'off (CARWASH_NO_CACHE_TIMER is set)');
  assert.equal(cacheTimerRow(env, true), 'off (CARWASH_NO_CACHE_TIMER is set)');
  checkCache(env, seen('r1', T0), seen('r2', T0 + 20 * MIN));
  assert.equal(cacheTimerRow(env), 'on, timed from when each request was sent · right after all 1 pauses checked');
  checkCache(env, seen('r2', T0 + 20 * MIN), seen('r3', T0 + 45 * MIN, { read: 0 }));
  assert.equal(cacheTimerRow(env), 'on, timed from when each request was sent · cache gone after 1 of 2 pauses it called warm (last: 25 min pause, read 0 of ~100k)');
  checkCache(env, null, seen('r9', T0, { method: 'replies' }));
  assert.match(cacheTimerRow(env), /^on, timed from replies/);
});

const plain = { TERM_PROGRAM: 'xterm', NO_COLOR: '1' };
const colour = { TERM_PROGRAM: 'xterm', COLORTERM: 'truecolor' };
const usage = { context_window: { context_window_size: 200_000, used_percentage: 68, current_usage: { input_tokens: 136_000 } } };
const left = (minutes, ttlMs = HOUR) => ({ leftMs: minutes * MIN, ttlMs });
const line = (cache, columns = Infinity, extra = {}) => render(usage, { env: plain, columns, cache, ...extra }).text;

test('the timer reads in whole minutes, rounded down', () => {
  assert.equal(cacheSegment(left(42.99), 'none').text, 'cache 42m');
  assert.equal(cacheSegment(left(1), 'none').text, 'cache 1m');
  assert.equal(cacheSegment(left(0.5), 'none').text, 'cache <1m');
  assert.equal(cacheSegment(left(0), 'none').text, 'cache expired');
  assert.equal(cacheSegment(left(-30), 'none').text, 'cache expired');
  assert.equal(cacheSegment(null, 'none'), null);
  assert.equal(cacheSegment({ leftMs: NaN, ttlMs: HOUR }, 'none'), null);
});

test('plain until the last stretch, then amber, then red; grey once expired', () => {
  const paintOf = (cache) => cacheSegment(cache, 'truecolor').text.match(/^\x1b\[38;2;([0-9;]+)m/)?.[1] ?? 'plain';
  assert.equal(paintOf(left(42)), 'plain');
  assert.equal(paintOf(left(10.5)), 'plain');
  assert.equal(paintOf(left(10)), '217;121;38');
  assert.equal(paintOf(left(5.5)), '217;121;38');
  assert.equal(paintOf(left(5)), '196;61;50');
  assert.equal(paintOf(left(0.2)), '196;61;50');
  assert.equal(paintOf(left(0)), '138;138;138');
  // The five-minute cache's stretch is its last two minutes.
  assert.equal(paintOf(left(3, 5 * MIN)), 'plain');
  assert.equal(paintOf(left(2, 5 * MIN)), '217;121;38');
  assert.equal(paintOf(left(1, 5 * MIN)), '196;61;50');
  assert.equal(cacheSegment(left(5), 'truecolor').warning, true);
  assert.equal(cacheSegment(left(11), 'truecolor').warning, false);
  assert.equal(cacheSegment(left(0), 'truecolor').warning, false);
});

test('the timer sits between the bar and the invitation, which says why now in the last stretch', () => {
  assert.equal(line(left(42)), 'session context ~136k  [██████████░░░░░]  cache 42m  /wash to compress & save context, then /clear keeps compressed context');
  assert.equal(line(left(7)), "session context ~136k  [██████████░░░░░]  cache 7m  /wash now while it's still cheap");
  assert.equal(line(left(0)), 'session context ~136k  [██████████░░░░░]  cache expired  /wash to compress & save context, then /clear keeps compressed context');
  // Without a timer, the line is as before.
  assert.equal(line(null), 'session context ~136k  [██████████░░░░░]  /wash to compress & save context, then /clear keeps compressed context');
  // While a brief is being written or waits for /clear, no timer.
  assert.doesNotMatch(line(left(7), Infinity, { state: { washing: 'mid' } }), /cache/);
  assert.doesNotMatch(line(left(7), Infinity, { state: { ready: { level: 'mid', tokens: 3100 } } }), /cache/);
});

test('narrow windows shorten the invitation before the timer goes, and the timer goes before the bar', () => {
  // 80 columns, Terminal.app's default, leaves 76.
  assert.equal(line(left(42), 76), 'session context ~136k  [██████████░░░░░]  cache 42m  /wash to compress');
  assert.equal(line(left(7), 76), 'session context ~136k  [██████████░░░░░]  cache 7m  /wash now');
  assert.equal(line(left(0), 76), 'session context ~136k  [██████████░░░░░]  cache expired  /wash to compress');
  // About half a Mac screen.
  assert.equal(line(left(42), 101), 'session context ~136k  [██████████░░░░░]  cache 42m  /wash to compress & save context, then /clear');
  assert.equal(line(left(42), 59), 'session context ~136k  [██████████░░░░░]  /wash to compress');
  assert.equal(line(left(7), 59), 'session context ~136k  [██████████░░░░░]  /wash to compress');
  assert.equal(line(left(42), 58), 'session context ~136k  /wash to compress');
  // The timer outlasts the words "getting full"; the bar's colour still says it.
  const full = { context_window: { context_window_size: 200_000, used_percentage: 80, current_usage: { input_tokens: 160_000 } } };
  assert.equal(render(full, { env: plain, columns: 76, cache: left(42) }).text, 'session context ~160k  [████████████░░░]  cache 42m  /wash to compress');
  assert.equal(render(full, { env: plain, columns: Infinity, cache: left(42) }).text, 'session context ~160k  [████████████░░░]  cache 42m  getting full · /wash to compress & save context, then /clear keeps compressed context');
  for (let columns = 21; columns <= 140; columns++) {
    for (const cache of [left(42), left(7), left(2), left(0.5), left(0), left(3, 5 * MIN), null]) {
      for (const env of [plain, colour]) {
        for (const input of [usage, full]) {
          assert.ok(visibleWidth(render(input, { env, columns, cache }).text) <= columns, `overflow at ${columns}`);
        }
      }
    }
  }
});

test('where links are offered, the timer and the nudge come too', () => {
  const links = { light: 'http://127.0.0.1:1/l', mid: 'http://127.0.0.1:1/m', detailed: 'http://127.0.0.1:1/d' };
  const strip = (s) => s.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m/g, '');
  const at = (cache) => strip(render(usage, { env: { TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' }, columns: Infinity, links, platform: 'darwin', cache }).text);
  assert.equal(at(left(42)), 'session context ~136k  [██████████░░░░░]  cache 42m  Compress & New Session (⌘-click): light ≤1.4k · mid ≤4.1k · detailed ≤13.6k');
  assert.equal(at(left(7)), "session context ~136k  [██████████░░░░░]  cache 7m  Wash now while it's still cheap (⌘-click): light ≤1.4k · mid ≤4.1k · detailed ≤13.6k");
});

test('the status line shows the timer from the session file', async () => {
  const now = Date.now();
  const file = transcript(turn(1, now - 17.5 * MIN));
  const env = { ...process.env, ...plain, CARWASH_HOME: dir() };
  for (const key of ['COLUMNS', 'FORCE_HYPERLINK', 'CARWASH_NO_CACHE_TIMER']) delete env[key];
  const input = JSON.stringify({ ...payloadFor(file), ...usage });
  assert.equal(await statusline({ input, env }), 'session context ~136k  [██████████░░░░░]  cache 42m  /wash to compress & save context, then /clear keeps compressed context');
  assert.equal(await statusline({ input, env: { ...env, COLUMNS: '80' } }), 'session context ~136k  [██████████░░░░░]  cache 42m  /wash to compress');
  assert.equal(await statusline({ input, env: { ...env, CARWASH_NO_CACHE_TIMER: '1' } }), 'session context ~136k  [██████████░░░░░]  /wash to compress & save context, then /clear keeps compressed context');
});

test('/wash help and the update notice explain the timer in Claude Code only', () => {
  assert.match(helpMessage(136_000), /cache 42m/);
  assert.doesNotMatch(helpMessage(136_000, null, 'codex'), /cache 42m/);
  assert.match(whatsNewMessage('0.2.6', '0.2.7'), /Cache timer/);
  assert.equal(whatsNewMessage('0.2.6', '0.2.7', 'codex'), null);
  // Updating from before 0.2.4, Codex still hears about notes.
  assert.match(whatsNewMessage('0.2.3', '0.2.7', 'codex'), /\$wash keep/);
  assert.doesNotMatch(whatsNewMessage('0.2.3', '0.2.7', 'codex'), /Cache timer/);
});
