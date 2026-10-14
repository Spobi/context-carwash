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
  assert.equal(formatTokens(20_000), '20k');
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

const HINT = '/wash to compress & save context, then /clear';

test('the reading is the tokens in use, then the bar and what /wash does', () => {
  assert.equal(render(payload(68), { env: plain, columns: Infinity }).text, `context ~136k  [██████████░░░░░]  ${HINT}`);
  assert.equal(render(payload(10), { env: plain, columns: Infinity }).text, `context ~20k  [██░░░░░░░░░░░░░]  ${HINT}`);
  // The window size is never spelled out: the bar shows how much of it is used.
  assert.equal(render(payload(3.8, 1_000_000), { env: plain, columns: Infinity }).text, `context ~38k  [█░░░░░░░░░░░░░░]  ${HINT}`);
  // Usage known but not the window size: the bar stays empty.
  assert.equal(
    render({ context_window: { current_usage: { input_tokens: 136_000 } } }, { env: plain, columns: Infinity }).text,
    `context ~136k  [░░░░░░░░░░░░░░░]  ${HINT}`,
  );
});

test('no percentage is ever shown', () => {
  const links = { light: 'http://127.0.0.1:1/l', mid: 'http://127.0.0.1:1/m', detailed: 'http://127.0.0.1:1/d' };
  const states = [undefined, { washing: 'mid' }, { ready: { level: 'mid', tokens: 3100 } }];
  for (const env of [plain, apple, { TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' }]) {
    for (const state of states) {
      for (const columns of [Infinity, 120, 100, 80, 60, 40, 20, 9]) {
        for (const input of [payload(68), payload(100), payload(null), {}]) {
          assert.doesNotMatch(render(input, { env, columns, state, links }).text, /%/);
        }
      }
    }
  }
});

test('Terminal.app gets the same line as any other terminal while no links are offered', () => {
  for (const columns of [Infinity, 120, 80, 60]) {
    assert.equal(render(payload(68), { env: apple, columns }).text, render(payload(68), { env: plain, columns }).text);
  }
});

test('unknown reading shows dashes and an empty bar', () => {
  for (const input of [null, {}, 'garbage', payload(null)]) {
    assert.equal(render(input, { env: plain, columns: Infinity }).text, `context --  [░░░░░░░░░░░░░░░]  ${HINT}`);
  }
});

test('narrow widths drop detail in order and always fit', () => {
  const at = (columns, env = apple) => render(payload(68), { env, columns });
  assert.equal(at(79).text, `context ~136k  [██████████░░░░░]  ${HINT}`);
  // The invitation shortens first. The middle form is what an 80-column window shows.
  assert.equal(at(78).text, 'context ~136k  [██████████░░░░░]  /wash to compress, then /clear');
  assert.equal(at(76).text, 'context ~136k  [██████████░░░░░]  /wash to compress, then /clear');
  assert.equal(at(64).text, 'context ~136k  [██████████░░░░░]  /wash to compress, then /clear');
  assert.equal(at(63).text, 'context ~136k  [██████████░░░░░]  /wash, then /clear');
  assert.equal(at(52).text, 'context ~136k  [██████████░░░░░]  /wash, then /clear');
  // Then the bar, then everything but the count.
  assert.equal(at(51).text, 'context ~136k  /wash, then /clear');
  assert.equal(at(33).text, 'context ~136k  /wash, then /clear');
  assert.equal(at(32).text, 'context ~136k');
  assert.equal(at(13).text, 'context ~136k');
  assert.equal(at(3).text, 'context ~136k');
  assert.equal(at(52).hasBar, true);
  assert.equal(at(51).hasBar, false);
  // The shortest reading, "context ~136k", is 13 columns: below that nothing can fit.
  for (let columns = 13; columns <= 130; columns++) {
    for (const env of [apple, plain, { TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor' }]) {
      for (const pct of [68, 80]) {
        assert.ok(visibleWidth(render(payload(pct), { env, columns }).text) <= columns, `overflow at ${columns} (${pct})`);
      }
    }
  }
});

test('from three quarters on, the meter says "getting full"', () => {
  const line = (pct, options = {}) => render(payload(pct), { env: plain, columns: Infinity, ...options }).text;
  assert.equal(line(74), `context ~148k  [███████████░░░░]  ${HINT}`);
  assert.equal(line(75), `context ~150k  [███████████░░░░]  getting full · ${HINT}`);
  assert.equal(line(100), `context ~200k  [███████████████]  getting full · ${HINT}`);
  // An unknown reading is never full.
  assert.doesNotMatch(render({}, { env: plain, columns: Infinity }).text, /getting full/);
  // Once a wash is under way there is nothing to add.
  assert.doesNotMatch(line(90, { state: { washing: 'mid' } }), /getting full/);
  assert.doesNotMatch(line(90, { state: { ready: { level: 'mid', tokens: 3100 } } }), /getting full/);
  // It says so where clicking is possible too.
  const links = { light: 'http://127.0.0.1:1/l', mid: 'http://127.0.0.1:1/m', detailed: 'http://127.0.0.1:1/d' };
  assert.match(strip(line(90, { env: { TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' }, links, platform: 'darwin' })), /\]  getting full · Compress & New Session/);

  // The word outlasts the invitation and the bar.
  const at = (columns) => render(payload(75), { env: plain, columns }).text;
  assert.equal(at(80), 'context ~150k  [███████████░░░░]  getting full · /wash to compress, then /clear');
  assert.equal(at(48), 'context ~150k  getting full · /wash, then /clear');
  assert.equal(at(47), 'context ~150k  getting full');
  assert.equal(at(27), 'context ~150k  getting full');
  assert.equal(at(26), 'context ~150k');
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
  assert.equal(strip(linked), 'context ~136k  [██████████░░░░░]  Compress & New Session (⌘-click): light ≤1.4k · mid ≤4.1k · detailed ≤13.6k');
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
