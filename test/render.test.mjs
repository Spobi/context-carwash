import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorAt, colorDepth, paint, rgbTo256 } from '../src/statusline/color.mjs';
import { capLabels, formatTokens, readUsage, render } from '../src/statusline/render.mjs';
import { availableColumns, supportsLinks, visibleWidth } from '../src/statusline/terminal.mjs';

const payload = (pct, size = 200_000) => ({
  context_window: {
    context_window_size: size,
    used_percentage: pct,
    current_usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.round((pct / 100) * size) - 2 },
  },
});
const plain = { TERM_PROGRAM: 'xterm', NO_COLOR: '1' };
const apple = { TERM_PROGRAM: 'Apple_Terminal', NO_COLOR: '1' };
const strip = (s) => s.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m/g, '');

test('formatTokens', () => {
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(999.7), '1k');
  assert.equal(formatTokens(1360), '1.4k');
  assert.equal(formatTokens(4080), '4.1k');
  assert.equal(formatTokens(13600), '13.6k');
  assert.equal(formatTokens(99_960), '100k');
  assert.equal(formatTokens(136_000), '136k');
  assert.equal(formatTokens(200_000), '200k');
  assert.equal(formatTokens(999_700), '1M');
  assert.equal(formatTokens(1_000_000), '1M');
  assert.equal(formatTokens(1_250_000), '1.3M');
});

test('caps are 1%, 3% and 10% of used context', () => {
  assert.deepEqual(capLabels(136_000), { light: '1.4k', mid: '4.1k', detailed: '13.6k' });
  assert.equal(capLabels(null), null);
  assert.equal(capLabels(0), null);
});

test('gradient hits every anchor and interpolates between them', () => {
  assert.deepEqual(colorAt(0), [0x17, 0x6b, 0x42]);
  assert.deepEqual(colorAt(45), [0xa9, 0xa9, 0x1d]);
  assert.deepEqual(colorAt(60), [0xd9, 0x79, 0x26]);
  assert.deepEqual(colorAt(75), [0xc4, 0x3d, 0x32]);
  assert.deepEqual(colorAt(90), [0x74, 0x1a, 0x22]);
  assert.deepEqual(colorAt(100), [0x74, 0x1a, 0x22]);
  assert.deepEqual(colorAt(95), [0x74, 0x1a, 0x22]);
  assert.deepEqual(colorAt(22.5), [96, 138, 48]);
  assert.deepEqual(colorAt(-5), colorAt(0));
  assert.deepEqual(colorAt(250), colorAt(100));
  assert.deepEqual(colorAt(NaN), colorAt(0));
});

test('gradient is smooth: no channel jumps more than a few steps per percent', () => {
  for (let p = 0; p < 100; p++) {
    const [a, b] = [colorAt(p), colorAt(p + 1)];
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[k] - b[k]) <= 8, `jump at ${p}%`);
  }
});

test('colour depth follows the environment', () => {
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }), 'truecolor');
  assert.equal(colorDepth({ TERM: 'xterm-256color' }), '256');
  assert.equal(colorDepth({ COLORTERM: 'truecolor', NO_COLOR: '1' }), 'none');
  assert.equal(colorDepth({ TERM: 'dumb' }), 'none');
  assert.equal(paint('x', [1, 2, 3], 'truecolor'), '\x1b[38;2;1;2;3mx\x1b[39m');
  assert.equal(paint('x', [255, 0, 0], '256'), '\x1b[38;5;196mx\x1b[39m');
  assert.equal(paint('x', [1, 2, 3], 'none'), 'x');
  assert.equal(rgbTo256([128, 128, 128]), 244);
});

test('readUsage tolerates every missing or null field', () => {
  const empty = { pct: null, used: null, size: null };
  for (const bad of [null, undefined, 'text', 42, [], {}, { context_window: null }, { context_window: 'x' }]) {
    assert.deepEqual(readUsage(bad), empty);
  }
  assert.deepEqual(
    readUsage({ context_window: { context_window_size: 200_000, used_percentage: null, current_usage: null } }),
    { pct: null, used: null, size: 200_000 },
  );
  // percentage only: tokens are derived from it
  assert.deepEqual(readUsage({ context_window: { context_window_size: 200_000, used_percentage: 68 } }), {
    pct: 68,
    used: 136_000,
    size: 200_000,
  });
  // usage only: percentage is derived from it
  const derived = readUsage({
    context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 2, cache_creation_input_tokens: 633, cache_read_input_tokens: 37_435 } },
  });
  assert.equal(derived.used, 38_070);
  assert.ok(Math.abs(derived.pct - 3.807) < 1e-9);
  assert.equal(readUsage({ context_window: { used_percentage: 140 } }).pct, 100);
  assert.equal(readUsage({ context_window: { used_percentage: '68' } }).pct, null);
});

test('full line matches the plan example', () => {
  assert.equal(
    render(payload(68), { env: plain, columns: Infinity }).text,
    'ctx 68%  ~136k/200k  [██████████░░░░░]  Type /wash light ≤1.4k | mid ≤4.1k | detailed ≤13.6k',
  );
});

test('Terminal.app gets the permanent typed-command sentence', () => {
  assert.equal(
    render(payload(68), { env: apple, columns: Infinity }).text,
    "ctx 68%  ~136k/200k  [██████████░░░░░]  Terminal.app can't click links. Type /wash light ≤1.4k | mid ≤4.1k | detailed ≤13.6k",
  );
});

test('unknown reading shows dashes, an empty bar and no estimates', () => {
  for (const input of [null, {}, 'garbage', payload(null)]) {
    assert.equal(render(input, { env: plain, columns: Infinity }).text, 'ctx --  [░░░░░░░░░░░░░░░]  Type /wash light | mid | detailed');
  }
});

test('narrow widths drop detail in order and always fit', () => {
  const at = (columns, env = apple) => render(payload(68), { env, columns });
  assert.equal(at(124).text, "ctx 68%  ~136k/200k  [██████████░░░░░]  Terminal.app can't click links. Type /wash light ≤1.4k | mid ≤4.1k | detailed ≤13.6k");
  assert.equal(at(123).text, "ctx 68%  ~136k/200k  [██████████░░░░░]  Terminal.app can't click links. Type /wash light | mid | detailed");
  assert.equal(at(105).text, "ctx 68%  ~136k/200k  [██████████░░░░░]  Terminal.app can't click links. Type /wash light | mid | detailed");
  assert.equal(at(104).text, "ctx 68%  [██████████░░░░░]  Terminal.app can't click links. Type /wash light | mid | detailed");
  assert.equal(at(93).text, "ctx 68%  [██████████░░░░░]  Terminal.app can't click links. Type /wash light | mid | detailed");
  assert.equal(at(92).text, 'ctx 68%  ~136k/200k  [██████████░░░░░]  Type /wash light | mid | detailed');
  assert.equal(at(76).text, 'ctx 68%  ~136k/200k  [██████████░░░░░]  Type /wash light | mid | detailed');
  assert.equal(at(72).text, 'ctx 68%  [██████████░░░░░]  Type /wash light | mid | detailed');
  assert.equal(at(56).text, 'ctx 68%  Type /wash light | mid | detailed');
  assert.equal(at(26).text, 'ctx 68%');
  assert.equal(at(3).text, 'ctx 68%');
  assert.equal(at(76).hasBar, true);
  assert.equal(at(56).hasBar, false);
  for (let columns = 7; columns <= 130; columns++) {
    for (const env of [apple, plain, { TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor' }]) {
      assert.ok(visibleWidth(render(payload(68), { env, columns }).text) <= columns, `overflow at ${columns}`);
    }
  }
});

test('bar fills in proportion and is coloured cell by cell', () => {
  const cells = (pct, env = plain) => (strip(render(payload(pct), { env, columns: Infinity }).text).match(/█/g) ?? []).length;
  assert.equal(cells(0), 0);
  assert.equal(cells(3), 0);
  assert.equal(cells(4), 1);
  assert.equal(cells(50), 8);
  assert.equal(cells(68), 10);
  assert.equal(cells(100), 15);

  const env = { TERM_PROGRAM: 'xterm', COLORTERM: 'truecolor' };
  const ramp = render(payload(100), { env, columns: Infinity }).text;
  assert.equal(new Set(ramp.match(/\x1b\[38;2;[0-9;]+m/g)).size > 5, true);
  const solid = render(payload(100), { env, columns: Infinity, barStyle: 'solid' }).text;
  assert.deepEqual([...new Set(solid.match(/\x1b\[38;2;[0-9;]+m/g))], ['\x1b[38;2;116;26;34m']);
  assert.equal(strip(ramp), strip(solid));
  assert.equal(visibleWidth(ramp), visibleWidth(strip(ramp)));
});

test('links wrap only the level names, and only where the terminal can click', () => {
  const links = { light: 'http://127.0.0.1:1/l', mid: 'http://127.0.0.1:1/m', detailed: 'http://127.0.0.1:1/d' };
  const iterm = { TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' };
  const linked = render(payload(68), { env: iterm, columns: Infinity, links, platform: 'darwin' }).text;
  assert.equal(strip(linked), 'ctx 68%  ~136k/200k  [██████████░░░░░]  Compress & New Session (⌘-click): light ≤1.4k · mid ≤4.1k · detailed ≤13.6k');
  assert.deepEqual(
    [...linked.matchAll(/\x1b\]8;;([^\x07]+)\x07([^\x1b]+)\x1b\]8;;\x07/g)].map((m) => [m[1], m[2]]),
    [[links.light, 'light'], [links.mid, 'mid'], [links.detailed, 'detailed']],
  );
  assert.match(render(payload(68), { env: iterm, columns: Infinity, links, platform: 'linux' }).text, /\(Ctrl-click\)/);
  // Terminal.app never gets links, even when they are offered.
  assert.doesNotMatch(render(payload(68), { env: apple, columns: Infinity, links }).text, /\x1b\]8/);
});

test('link support detection', () => {
  assert.equal(supportsLinks({ TERM_PROGRAM: 'Apple_Terminal' }), false);
  assert.equal(supportsLinks({ TERM_PROGRAM: 'Apple_Terminal', FORCE_HYPERLINK: '1' }), true);
  assert.equal(supportsLinks({ TERM_PROGRAM: 'iTerm.app' }), true);
  assert.equal(supportsLinks({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux' }), false);
  assert.equal(supportsLinks({ TERM_PROGRAM: 'vscode' }), true);
  assert.equal(supportsLinks({ TERM_PROGRAM: 'ghostty' }), true);
  assert.equal(supportsLinks({ WT_SESSION: 'abc' }), true);
  assert.equal(supportsLinks({ TERM: 'xterm-256color' }), false);
  assert.equal(supportsLinks({}), false);
});

test('available columns leaves room for the margins Claude Code adds', () => {
  assert.equal(availableColumns({ COLUMNS: '120' }), 116);
  assert.equal(availableColumns({ COLUMNS: '3' }), 1);
  assert.equal(availableColumns({}), Infinity);
  assert.equal(availableColumns({ COLUMNS: 'wide' }), Infinity);
});
