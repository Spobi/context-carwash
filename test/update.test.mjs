import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { packageVersion } from '../src/install/install.mjs';
import { isNewer, latestVersion } from '../src/install/update.mjs';

test('a later release is newer, by number and not by text', () => {
  assert.equal(isNewer('0.1.2', '0.1.1'), true);
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.1', '0.1.1'), false);
  assert.equal(isNewer('0.1.0', '0.1.1'), false);
  // Anything unreadable is never newer.
  for (const latest of [null, undefined, '', 'garbage', '0.2.0-beta.1', 2]) assert.equal(isNewer(latest, '0.1.1'), false);
});

test('opting out means no request at all', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('fetched despite CARWASH_NO_UPDATE_CHECK');
  try {
    assert.equal(await latestVersion({ env: { CARWASH_NO_UPDATE_CHECK: '1' } }), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('offline, failing or odd answers from npm are no answer', async () => {
  const original = globalThis.fetch;
  const cases = [
    [() => Promise.reject(new Error('offline')), null],
    [async () => ({ ok: false, json: async () => ({ version: '9.9.9' }) }), null],
    [async () => ({ ok: true, json: async () => ({ nope: 1 }) }), null],
    [async () => ({ ok: true, json: async () => ({ version: '0.3.0' }) }), '0.3.0'],
  ];
  try {
    for (const [fake, expected] of cases) {
      globalThis.fetch = fake;
      assert.equal(await latestVersion({ env: {} }), expected);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('an out-of-date installer hands over to the newest release, once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carwash-update-'));
  const base = { ...process.env, CARWASH_HOME: join(root, 'carwash'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
  delete base.CARWASH_HANDED_OFF;
  const sink = () => {
    const stream = new Writable({ write: (chunk, _enc, done) => ((stream.text += chunk), done()) });
    stream.text = '';
    return stream;
  };
  const run = async (latest, { env = base, status = 0 } = {}) => {
    const stdout = sink();
    const stderr = sink();
    const calls = [];
    const handOff = (version, args) => (calls.push([version, args]), status);
    const code = await main(['install', '--yes'], { env, stdin: { isTTY: false }, stdout, stderr, latest: async () => latest, handOff });
    return { code, calls, stdout: stdout.text };
  };

  // Behind: the newest release runs the install, with the same arguments, and
  // its exit code is ours. Nothing is changed by this copy.
  const behind = await run('99.0.0', { status: 3 });
  assert.deepEqual(behind.calls, [['99.0.0', ['install', '--yes']]]);
  assert.equal(behind.code, 3);
  assert.match(behind.stdout, /^This is Context Carwash \d+\.\d+\.\d+, and 99\.0\.0 is out\. Installing 99\.0\.0 instead\.\n\n$/);
  assert.equal(existsSync(base.CARWASH_HOME), false);

  // Up to date, or no answer from npm: install here, no hand-off.
  for (const latest of [packageVersion(), '0.0.1', null]) {
    const result = await run(latest);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /Installed\./);
  }

  // The release handed over to never hands over again.
  const handedOff = await run('99.0.0', { env: { ...base, CARWASH_HANDED_OFF: '99.0.0' } });
  assert.deepEqual(handedOff.calls, []);
  assert.match(handedOff.stdout, /Installed\./);

  // npx could not start: say so and install with this copy.
  const stuck = await run('99.0.0', { status: null });
  assert.match(stuck.stdout, /Could not start 99\.0\.0, so continuing with/);
  assert.match(stuck.stdout, /Installed\./);
});
