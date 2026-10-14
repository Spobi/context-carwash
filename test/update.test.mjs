import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { packageVersion } from '../src/install/install.mjs';
import { isNewer, latestVersion, updateNotice } from '../src/install/update.mjs';

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

test('the notice names both versions and the command, and only when behind', () => {
  const notice = updateNotice('0.1.1', '0.1.2');
  assert.match(notice, /newer Context Carwash is out: 0\.1\.2\. This installer is 0\.1\.1\./);
  assert.match(notice, /npx context-carwash@latest install/);
  assert.equal(updateNotice('0.1.2', '0.1.2'), null);
  assert.equal(updateNotice('0.1.2', null), null);
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

test('install says a newer version is out right before asking, and changes nothing on no', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carwash-update-'));
  const env = { ...process.env, CARWASH_HOME: join(root, 'carwash'), CLAUDE_CONFIG_DIR: join(root, 'claude') };
  const sink = () => {
    const stream = new Writable({ write: (chunk, _enc, done) => ((stream.text += chunk), done()) });
    stream.text = '';
    return stream;
  };
  const run = async (latest) => {
    const stdout = sink();
    const stderr = sink();
    const status = await main(['install'], { env, stdin: { isTTY: false }, stdout, stderr, latest: async () => latest });
    return { status, stdout: stdout.text, stderr: stderr.text };
  };

  const behind = await run('99.0.0');
  assert.equal(behind.status, 1);
  assert.match(behind.stdout, /will make these changes[\s\S]*newer Context Carwash is out: 99\.0\.0\. This installer is \d+\.\d+\.\d+\.\n.*@latest install\n\n$/);
  assert.match(behind.stderr, /Re-run with --yes/);

  for (const latest of [packageVersion(), '0.0.1', null]) assert.doesNotMatch((await run(latest)).stdout, /newer/);
});
