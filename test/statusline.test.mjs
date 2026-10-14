import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compose, runWrapped, shellFor, statusline } from '../src/statusline/run.mjs';

const BIN = fileURLToPath(new URL('../bin/carwash.mjs', import.meta.url));
const posix = process.platform !== 'win32';

// The real environment (Windows needs it to start anything), minus whatever
// would change how the meter renders on the machine running the tests.
function testEnv(extra = {}) {
  const env = { ...process.env, TERM_PROGRAM: 'xterm', NO_COLOR: '1', ...extra };
  for (const key of ['COLUMNS', 'LINES', 'FORCE_HYPERLINK', 'TMUX', 'STY', 'CLAUDE_CONFIG_DIR']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}
const plain = testEnv();
const input = JSON.stringify({
  session_id: 'abc',
  context_window: { context_window_size: 200_000, used_percentage: 68, current_usage: { input_tokens: 136_000 } },
});
const OURS = 'session context ~136k  [██████████░░░░░]  /wash to compress & save context, then /clear keeps compressed context';

// A Carwash home whose install record says the user had this status line.
function homeWrapping(command) {
  const home = mkdtempSync(join(tmpdir(), 'carwash-home-'));
  if (command !== undefined) {
    writeFileSync(join(home, 'install.json'), JSON.stringify({ statusLine: { original: { type: 'command', command } } }));
  }
  return home;
}

// A status line script written in Node, so the same test runs on every platform.
function script(body) {
  const dir = mkdtempSync(join(tmpdir(), 'carwash-script-'));
  const file = join(dir, 'theirs.mjs').replace(/\\/g, '/');
  writeFileSync(file, body);
  return `node ${file}`;
}

test('without an install record, only the meter is printed', async () => {
  assert.equal(await statusline({ input, env: { ...plain, CARWASH_HOME: homeWrapping() } }), OURS);
});

test('malformed or empty input still prints a meter', async () => {
  const env = { ...plain, CARWASH_HOME: homeWrapping() };
  for (const bad of ['', 'not json', '[1,2', 'null', '42']) {
    assert.equal(await statusline({ input: bad, env }), 'session context --  [░░░░░░░░░░░░░░░]  /wash to compress & save context, then /clear keeps compressed context');
  }
});

test('the wrapped status line receives the same stdin and keeps its place', async () => {
  const theirs = script(`
    let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
      const p = JSON.parse(s);
      console.log('theirs:' + p.session_id + ':' + p.context_window.used_percentage);
    });`);
  const env = { ...plain, CARWASH_HOME: homeWrapping(theirs) };
  assert.equal(await statusline({ input, env }), `theirs:abc:68 │ ${OURS}`);
});

test('a wrapped status line that fails, prints nothing or hangs does not break the meter', async () => {
  for (const body of ['process.exit(3)', '', 'throw new Error("boom")']) {
    const env = { ...plain, CARWASH_HOME: homeWrapping(script(body)) };
    assert.equal(await statusline({ input, env }), OURS);
  }
  assert.equal(await runWrapped('definitely-not-a-real-command-xyz', input, { env: plain }), null);
  const started = Date.now();
  assert.equal(await runWrapped(script('setTimeout(() => {}, 8000)'), input, { env: plain, timeoutMs: 300 }), null);
  assert.ok(Date.now() - started < 5000);
});

test('compose puts the meter beside a short line and below a long or crowded one', () => {
  const p = JSON.parse(input);
  const options = { env: plain, columns: 130 };
  assert.equal(compose('main ✓', p, options), `main ✓ │ ${OURS}`);
  // Colour codes in their output do not count towards its width.
  assert.equal(compose('\x1b[32mmain ✓\x1b[0m\n', p, options), `\x1b[32mmain ✓\x1b[0m │ ${OURS}`);
  // Less room beside theirs: the meter gives up detail before it gives up the line.
  assert.equal(compose('x'.repeat(50), p, options), `${'x'.repeat(50)} │ session context ~136k  [██████████░░░░░]  /wash to compress, then /clear`);
  // Not enough room left for the bar: the meter moves to its own line.
  const long = 'x'.repeat(80);
  assert.equal(compose(long, p, options), `${long}\n${OURS}`);
  // Multi-line output: only the last line is considered.
  assert.equal(compose(`${long}\nmain ✓`, p, options), `${long}\nmain ✓ │ ${OURS}`);
  assert.equal(compose(null, p, options), OURS);
  assert.equal(compose('  \n', p, options), OURS);
});

test('the wrapped command runs in the shell Claude Code would use', () => {
  assert.deepEqual(shellFor('x', {}, 'darwin'), ['/bin/sh', ['-c', 'x']]);
  assert.deepEqual(shellFor('x', {}, 'linux'), ['/bin/sh', ['-c', 'x']]);
  assert.deepEqual(shellFor('x', { MSYSTEM: 'MINGW64' }, 'win32'), ['bash', ['-c', 'x']]);
  assert.deepEqual(shellFor('x', { SHELL: 'C:/Program Files/Git/usr/bin/bash.exe' }, 'win32'), ['bash', ['-c', 'x']]);
  assert.deepEqual(shellFor('x', {}, 'win32'), ['powershell', ['-NoProfile', '-Command', 'x']]);
});

test('shell syntax in a wrapped command works', { skip: !posix }, async () => {
  const env = { ...plain, CARWASH_HOME: homeWrapping(`cat >/dev/null; printf '%s' "$((40 + 2)) ok"`) };
  assert.equal(await statusline({ input, env }), `42 ok │ ${OURS}`);
});

test('the carwash statusline command works end to end', () => {
  const run = (stdin, env) => spawnSync(process.execPath, [BIN, 'statusline'], { input: stdin, encoding: 'utf8', env: testEnv(env) });
  const home = homeWrapping();
  let result = run(input, { CARWASH_HOME: home, COLUMNS: '80' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'session context ~136k  [██████████░░░░░]  /wash to compress, then /clear\n');
  assert.equal(result.stderr, '');

  result = run('garbage', { CARWASH_HOME: home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'session context --  [░░░░░░░░░░░░░░░]  /wash to compress & save context, then /clear keeps compressed context\n');

  // A corrupt install record must not take the status line down.
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'install.json'), '{ not json');
  result = run(input, { CARWASH_HOME: home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, OURS + '\n');
});
