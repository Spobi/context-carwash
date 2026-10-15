import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { doctorReport, recentErrors } from '../src/install/doctor.mjs';
import { commandFor } from '../src/install/install.mjs';
import { fetchNotice, noticeFor, readNotice, refreshNotice, startCheck, startNotice, statusNotice, unseenErrors, versionLine } from '../src/install/notice.mjs';
import { withNotice } from '../src/statusline/run.mjs';
import { runHook } from '../src/wash/hooks.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 86_400_000;

function home() {
  const root = mkdtempSync(join(tmpdir(), 'carwash-notice-'));
  const env = { CARWASH_HOME: join(root, 'carwash'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), COLUMNS: '200' };
  mkdirSync(env.CARWASH_HOME, { recursive: true });
  return env;
}

const sink = () => {
  const stream = new Writable({ write: (chunk, _enc, done) => ((stream.text += chunk), done()) });
  stream.text = '';
  return stream;
};

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const npm = (doc) => async () => ({ ok: true, json: async () => doc });

test('npm is read for the newest version and the warning on this one', async () => {
  const doc = { 'dist-tags': { latest: '0.1.7' }, versions: { '0.1.5': { deprecated: 'Briefs\u001b[31m can be lost.\n Please update.' }, '0.1.7': {} } };
  await withFetch(npm(doc), async () => {
    assert.deepEqual(await fetchNotice('0.1.5', { env: {} }), { latest: '0.1.7', warning: 'Briefs [31m can be lost. Please update.' });
    assert.deepEqual(await fetchNotice('0.1.7', { env: {} }), { latest: '0.1.7', warning: null });
  });
  await withFetch(() => Promise.reject(new Error('offline')), async () => assert.equal(await fetchNotice('0.1.5', { env: {} }), null));
  await withFetch(npm({ nope: 1 }), async () => assert.equal(await fetchNotice('0.1.5', { env: {} }), null));
  await withFetch(() => assert.fail('fetched despite opting out'), async () => assert.equal(await fetchNotice('0.1.5', { env: { CARWASH_NO_UPDATE_CHECK: '1' } }), null));
});

test('a long warning is cut short', async () => {
  const doc = { 'dist-tags': { latest: '0.1.7' }, versions: { '0.1.5': { deprecated: 'x'.repeat(500) } } };
  const { warning } = await withFetch(npm(doc), () => fetchNotice('0.1.5', { env: {} }));
  assert.equal([...warning].length, 200);
  assert.ok(warning.endsWith('…'));
});

test('the check runs at most once a day and never makes the session wait', async () => {
  const env = home();
  const runs = [];
  const run = () => runs.push(1);
  assert.equal(startCheck('0.1.5', { env, now: NOW, run }), true);
  assert.equal(startCheck('0.1.5', { env, now: NOW + DAY / 2, run }), false);
  assert.equal(startCheck('0.1.5', { env, now: NOW + DAY + 1, run }), true);
  assert.equal(runs.length, 2);
  assert.equal(startCheck('0.1.5', { env: { ...env, CARWASH_NO_UPDATE_CHECK: '1' }, now: NOW + 3 * DAY, run }), false);

  // The background half keeps what it found, and keeps the last good answer
  // when offline.
  await refreshNotice('0.1.5', { env, now: NOW, fetchNotice: async () => ({ latest: '0.1.6', warning: 'Bug in /wash.' }) });
  await refreshNotice('0.1.5', { env, now: NOW + DAY, fetchNotice: async () => null });
  assert.equal(readNotice(env).latest, '0.1.6');
  assert.equal(readNotice(env).warning, 'Bug in /wash.');
});

test('what is said depends on the version running', () => {
  const notice = { version: '0.1.5', latest: '0.1.7', warning: 'Bug in /wash.' };
  assert.deepEqual(noticeFor(notice, '0.1.5', {}), { kind: 'warning', latest: '0.1.7', warning: 'Bug in /wash.' });
  // Updated since the check: the warning was about the old version.
  assert.deepEqual(noticeFor(notice, '0.1.6', {}), { kind: 'update', latest: '0.1.7', warning: null });
  assert.equal(noticeFor(notice, '0.1.7', {}), null);
  assert.equal(noticeFor(notice, '0.1.5', { CARWASH_NO_UPDATE_CHECK: '1' }), null);
  assert.equal(noticeFor(null, '0.1.5', {}), null);
});

test('the status line and session start pass the news on', () => {
  const env = home();
  assert.equal(statusNotice('0.1.5', env), null);
  assert.equal(withNotice('meter', env, '0.1.5'), 'meter');

  writeFileSync(join(env.CARWASH_HOME, 'notice.json'), JSON.stringify({ version: '0.1.5', latest: '0.1.6', warning: null }));
  assert.equal(statusNotice('0.1.5', env), 'Carwash 0.1.6 is out (you have 0.1.5) · npx context-carwash@latest install');
  assert.equal(startNotice('0.1.5', env), 'Carwash 0.1.6 is out (you have 0.1.5). To update: npx context-carwash@latest install');
  assert.match(versionLine('0.1.5', env), /^Carwash 0\.1\.5\. 0\.1\.6 is out\./);
  assert.equal(withNotice('meter', env, '0.1.5'), 'meter\nCarwash 0.1.6 is out (you have 0.1.5) · npx context-carwash@latest install');
  // Cut to the window rather than wrapped.
  const narrow = withNotice('meter', { ...env, COLUMNS: '30' }, '0.1.5').split('\n')[1];
  assert.ok(narrow.endsWith('…') && [...narrow].length <= 30);

  writeFileSync(join(env.CARWASH_HOME, 'notice.json'), JSON.stringify({ version: '0.1.5', latest: '0.1.6', warning: 'Bug in /wash.' }));
  assert.equal(statusNotice('0.1.5', env), '⚠ Carwash: Bug in /wash. · to update: npx context-carwash@latest install');
  assert.equal(startNotice('0.1.5', env), 'Carwash 0.1.5: Bug in /wash. To update: npx context-carwash@latest install');
});

test('hook errors show under the meter until doctor has shown them', async () => {
  const env = home();
  assert.equal(unseenErrors(env), false);
  const log = join(env.CARWASH_HOME, 'errors.log');
  writeFileSync(log, '2026-10-14T11:00:00.000Z Error: boom\n    at hook (file.mjs:1:1)\n');
  assert.equal(unseenErrors(env), true);
  assert.equal(statusNotice('9.9.9', env), 'Carwash hit an error · details: npx context-carwash doctor');

  const stdout = sink();
  await main(['doctor'], { env, stdout, notice: async () => null, claude: () => '2.1.0 (Claude Code)' });
  assert.match(stdout.text, /Error: boom/);
  // The seen mark is written now; make sure the log reads as older.
  utimesSync(log, new Date(NOW - DAY), new Date(NOW - DAY));
  assert.equal(unseenErrors(env), false);
  assert.equal(statusNotice('9.9.9', env), null);
});

test('doctor lists what a bug report needs', () => {
  const env = home();
  const before = doctorReport({ env, running: '0.1.6', newest: null, claude: null });
  assert.match(before, /Installed\s+no \(run: npx context-carwash install\)/);
  assert.match(before, /Newest on npm\s+could not check/);
  assert.match(before, /Claude Code\s+not found on PATH/);
  assert.match(before, /Errors: none logged\./);
  assert.match(before, /github\.com\/Spobi\/context-carwash\/issues\/new/);
  assert.match(before, /Issues are public, so look it over first/);

  writeFileSync(join(env.CARWASH_HOME, 'install.json'), JSON.stringify({ version: '0.1.5', installedAt: '2026-10-03T10:00:00Z' }));
  const after = doctorReport({ env, running: '0.1.6', newest: { latest: '0.1.6', warning: 'Bug in /wash.' }, claude: '2.1.0 (Claude Code)' });
  assert.match(after, /Installed\s+0\.1\.5 \(first installed 3 Oct 2026\)/);
  assert.match(after, /This copy\s+0\.1\.6/);
  assert.match(after, /Newest on npm\s+0\.1\.6 · to update: npx context-carwash@latest install/);
  assert.match(after, /Warning\s+Bug in \/wash\./);
  assert.match(after, /Status line\s+MISSING/);
  assert.match(after, /Hooks\s+SessionStart MISSING · Stop MISSING · UserPromptExpansion MISSING/);
  assert.match(after, /\/wash command\s+MISSING/);
});

test('doctor notices when the Node Carwash runs with is gone', () => {
  const env = home();
  writeFileSync(join(env.CARWASH_HOME, 'install.json'), JSON.stringify({ version: '0.1.7' }));
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const report = (nodePath) => {
    const command = (verb) => commandFor(verb, { nodePath, scriptPath: '/h/.carwash/app/bin/carwash.mjs', platform: 'darwin' });
    const hook = { hooks: [{ type: 'command', command: command('hook') }] };
    const settings = { statusLine: { type: 'command', command: command('statusline') }, hooks: { SessionStart: [hook], Stop: [hook], UserPromptExpansion: [hook] } };
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify(settings));
    return doctorReport({ env, running: '0.1.7', newest: null, claude: null });
  };
  assert.match(report(process.execPath), /Node for Carwash\s+ok \(/);
  // As after `nvm uninstall` of the version Carwash was installed with.
  const gone = report(join(tmpdir(), 'no-such-node-version', 'bin', 'node'));
  assert.match(gone, /Status line\s+ok/);
  assert.match(gone, /Node for Carwash\s+MISSING: \S*no-such-node-version\S* · to fix: npx context-carwash@latest install/);
});

test('doctor keeps only the last few errors, each cut short', () => {
  const env = home();
  const entry = (n) => `2026-10-1${n}T10:00:00.000Z Error: e${n}\n${'    at x\n'.repeat(20)}`;
  writeFileSync(join(env.CARWASH_HOME, 'errors.log'), [1, 2, 3, 4, 5].map(entry).join(''));
  const errors = recentErrors(env);
  assert.deepEqual(errors.map((e) => e.split('\n')[0]), ['2026-10-13T10:00:00.000Z Error: e3', '2026-10-14T10:00:00.000Z Error: e4', '2026-10-15T10:00:00.000Z Error: e5']);
  assert.ok(errors.every((e) => e.split('\n').length === 9));
});

test('a session start starts the check and says what the last one found', () => {
  const env = home();
  writeFileSync(join(env.CARWASH_HOME, 'notice.json'), JSON.stringify({ version: '0.1.5', latest: '0.1.6', warning: null }));
  let checks = 0;
  const start = (source, extra = {}) =>
    runHook({
      input: JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: 'S1', cwd: tmpdir() }),
      env: { ...env, ...extra },
      now: NOW,
      version: '0.1.5',
      me: { pid: 1, start: 'x' },
      running: () => false,
      checkUpdates: () => checks++,
    });
  assert.equal(start('startup').systemMessage, 'Carwash 0.1.6 is out (you have 0.1.5). To update: npx context-carwash@latest install');
  assert.equal(start('clear').systemMessage, 'Carwash 0.1.6 is out (you have 0.1.5). To update: npx context-carwash@latest install');
  assert.equal(start('resume'), null);
  assert.equal(start('startup', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), null);
  assert.equal(checks, 2);
});
