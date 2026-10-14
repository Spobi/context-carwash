import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyInstall, applyUninstall, describeInstall, describeUninstall, isCarwashCommand, isCarwashHook, planInstall, planUninstall, statusLineCommand, withoutCarwashHooks } from '../src/install/install.mjs';
import { UserError } from '../src/install/settings.mjs';

const BIN = fileURLToPath(new URL('../bin/carwash.mjs', import.meta.url));
const posix = process.platform !== 'win32';

// A throwaway Claude config directory and Carwash home.
function sandbox(settingsText) {
  const root = mkdtempSync(join(tmpdir(), 'carwash-test-'));
  // CARWASH_NO_UPDATE_CHECK keeps the installer offline; the check has its own tests.
  const env = { ...process.env, CARWASH_HOME: join(root, 'carwash'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CARWASH_NO_UPDATE_CHECK: '1' };
  for (const key of ['COLUMNS', 'LINES', 'FORCE_HYPERLINK', 'TMUX', 'STY']) delete env[key];
  const file = join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  if (settingsText !== undefined) writeFileSync(file, settingsText);
  return { root, env, file, home: env.CARWASH_HOME };
}
const install = (env) => applyInstall(planInstall({ env }));
const uninstall = (env) => applyUninstall(planUninstall({ env }));
const read = (file) => readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file).replace(/^﻿/, ''));
const skillFile = (env) => join(env.CLAUDE_CONFIG_DIR, 'skills', 'wash', 'SKILL.md');
// The Carwash hook entries in a settings object, as [event, matcher] pairs.
const ourHooks = (settings) =>
  Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.filter((group) => group.hooks.some((hook) => isCarwashHook(hook.command))).map((group) => [event, group.matcher ?? null]),
  );
const ALL_HOOKS = [['SessionStart', 'startup|clear'], ['Stop', null], ['UserPromptExpansion', 'wash']];

test('fresh machine: install creates the setting, uninstall removes every trace', () => {
  const { env, file, home } = sandbox();
  assert.match(describeInstall(planInstall({ env })), /Create .*settings\.json/);
  install(env);
  const settings = json(file);
  assert.deepEqual(Object.keys(settings), ['statusLine', 'hooks']);
  assert.equal(settings.statusLine.type, 'command');
  assert.equal(settings.statusLine.refreshInterval, 5);
  assert.ok(isCarwashCommand(settings.statusLine.command));
  assert.deepEqual(ourHooks(settings), ALL_HOOKS);
  for (const groups of Object.values(settings.hooks)) {
    assert.deepEqual(Object.keys(groups[0].hooks[0]), ['type', 'command', 'timeout']);
    assert.equal(groups[0].hooks[0].command, settings.statusLine.command.replace(/statusline$/, 'hook'));
  }
  assert.ok(existsSync(join(home, 'app', 'bin', 'carwash.mjs')));
  assert.ok(existsSync(join(home, 'app', 'src', 'statusline', 'render.mjs')));
  assert.ok(existsSync(join(home, 'app', 'src', 'skill', 'SKILL.md')));
  assert.match(read(skillFile(env)), /^---\nname: wash\n[\s\S]*disable-model-invocation: true\n[\s\S]*\$ARGUMENTS/);

  const undo = describeUninstall(planUninstall({ env }));
  assert.match(undo, /1\. Delete .*settings\.json/);
  assert.match(undo, /2\. Remove the \/wash command at .*skills.wash\n  3\. Delete /);
  uninstall(env);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR, 'skills', 'wash')), false);
});

test('existing settings come back byte-for-byte, whatever their formatting', () => {
  const variants = [
    '{\n  "model": "opus",\n  "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "rtk hook claude"}]}]}\n}\n',
    '{\n    "model": "opus",\n    "theme": "dark"\n}',
    '{\n\t"model": "opus"\n}\n',
    '{"model":"opus"}',
    '{\r\n  "model": "opus"\r\n}\r\n',
    '\uFEFF{\n  "model": "opus"\n}\n',
    '{}',
  ];
  for (const original of variants) {
    const { env, file, home } = sandbox(original);
    install(env);
    const settings = json(file);
    assert.ok(isCarwashCommand(settings.statusLine.command));
    assert.deepEqual(ourHooks(settings), ALL_HOOKS);
    assert.equal(read(file).startsWith('﻿'), original.startsWith('﻿'));
    assert.equal(settings.model, original === '{}' ? undefined : 'opus');
    assert.equal(read(join(home, 'backup', 'settings.json')), original);
    assert.match(describeUninstall(planUninstall({ env })), /Restore .* to exactly what it was/);
    uninstall(env);
    assert.equal(read(file), original);
    assert.equal(existsSync(home), false);
  }
});

test('install keeps the file style it found', () => {
  const { env, file } = sandbox('{\n    "model": "opus"\n}');
  install(env);
  assert.match(read(file), /^\{\n    "model": "opus",\n    "statusLine": \{\n        "refreshInterval": 5,\n        "type": "command",/);
  assert.equal(read(file).endsWith('\n'), false);

  const crlf = sandbox('{\r\n  "model": "opus"\r\n}\r\n');
  install(crlf.env);
  assert.equal(/[^\r]\n/.test(read(crlf.file)), false);
});

test('an existing status line is wrapped, not replaced, and restored exactly', () => {
  const original = '{\n  "statusLine": {\n    "type": "command",\n    "command": "~/.claude/statusline.sh",\n    "padding": 2,\n    "refreshInterval": 5\n  },\n  "model": "opus"\n}\n';
  const { env, file, home } = sandbox(original);
  assert.match(describeInstall(planInstall({ env })), /Your status line keeps running[\s\S]*~\/\.claude\/statusline\.sh/);
  install(env);

  const settings = json(file);
  assert.deepEqual(Object.keys(settings), ['statusLine', 'model', 'hooks']);
  assert.ok(isCarwashCommand(settings.statusLine.command));
  assert.equal(settings.statusLine.padding, 2);
  assert.equal(settings.statusLine.refreshInterval, 5);
  assert.equal(json(join(home, 'install.json')).statusLine.original.command, '~/.claude/statusline.sh');

  uninstall(env);
  assert.equal(read(file), original);
});

test('settings edited after install: only our key is undone, the edits stay', () => {
  for (const [original, expected] of [
    ['{\n  "model": "opus"\n}\n', { model: 'opus', theme: 'dark' }],
    ['{\n  "statusLine": {"type": "command", "command": "mine.sh"},\n  "model": "opus"\n}\n', { statusLine: { type: 'command', command: 'mine.sh' }, model: 'opus', theme: 'dark' }],
  ]) {
    const { env, file, home } = sandbox(original);
    install(env);
    writeFileSync(file, JSON.stringify({ ...json(file), theme: 'dark' }, null, 2) + '\n');
    assert.match(describeUninstall(planUninstall({ env })), /your other changes stay/);
    uninstall(env);
    assert.deepEqual(json(file), expected);
    assert.equal(existsSync(home), false);
  }

  // Carwash created the file, then the user added to it: the file stays.
  const fresh = sandbox();
  install(fresh.env);
  writeFileSync(fresh.file, JSON.stringify({ ...json(fresh.file), theme: 'dark' }, null, 2) + '\n');
  uninstall(fresh.env);
  assert.deepEqual(json(fresh.file), { theme: 'dark' });
});

test('a status line the user set after install is left alone', () => {
  const { env, file, home } = sandbox('{\n  "model": "opus"\n}\n');
  install(env);
  const edited = JSON.stringify({ ...json(file), statusLine: { type: 'command', command: 'new.sh' } }, null, 2) + '\n';
  writeFileSync(file, edited);
  const plan = planUninstall({ env });
  assert.equal(plan.action, 'edit');
  assert.match(describeUninstall(plan), /changed after install, so it is left as it is/);
  applyUninstall(plan);
  assert.deepEqual(json(file), { model: 'opus', statusLine: { type: 'command', command: 'new.sh' } });
  assert.equal(existsSync(home), false);
});

test('a status line refresh interval the user already chose is kept', () => {
  const slow = sandbox('{"statusLine": {"type": "command", "command": "mine.sh", "refreshInterval": 60}}');
  install(slow.env);
  assert.equal(json(slow.file).statusLine.refreshInterval, 60);
  const none = sandbox('{"statusLine": {"type": "command", "command": "mine.sh"}}');
  install(none.env);
  assert.equal(json(none.file).statusLine.refreshInterval, 5);
  uninstall(none.env);
  assert.equal(read(none.file), '{"statusLine": {"type": "command", "command": "mine.sh"}}');
});

test('hooks the user already has are kept, in place, and ours go after them', () => {
  const original = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
    },
    model: 'opus',
  };
  const text = JSON.stringify(original, null, 2) + '\n';
  const { env, file } = sandbox(text);
  assert.match(describeInstall(planInstall({ env })), /Adds three hooks[\s\S]*The hooks you already have are kept as they are\./);
  install(env);

  const settings = json(file);
  assert.deepEqual(Object.keys(settings), ['hooks', 'model', 'statusLine']);
  assert.deepEqual(Object.keys(settings.hooks), ['Stop', 'PreToolUse', 'SessionStart', 'UserPromptExpansion']);
  assert.deepEqual(settings.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(settings.hooks.Stop[0], original.hooks.Stop[0]);
  assert.equal(settings.hooks.Stop.length, 2);
  assert.deepEqual(ourHooks(settings), [['Stop', null], ['SessionStart', 'startup|clear'], ['UserPromptExpansion', 'wash']]);

  // Edited afterwards: uninstall takes out exactly our entries.
  settings.theme = 'dark';
  settings.hooks.Stop[1].hooks.push({ type: 'command', command: 'theirs-in-our-group' });
  settings.hooks.Notification = [];
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  uninstall(env);
  assert.deepEqual(json(file), {
    hooks: {
      Stop: [original.hooks.Stop[0], { hooks: [{ type: 'command', command: 'theirs-in-our-group' }] }],
      PreToolUse: original.hooks.PreToolUse,
      Notification: [],
    },
    model: 'opus',
    theme: 'dark',
  });

  assert.doesNotMatch(describeInstall(planInstall({ env: sandbox('{}').env })), /already have/);
});

test('taking our hooks out leaves everything else exactly as it was', () => {
  const ours = { type: 'command', command: '/n/node /h/.carwash/app/bin/carwash.mjs hook', timeout: 20 };
  const theirs = { type: 'command', command: 'theirs' };
  const untouched = { Stop: [{ hooks: [theirs] }], Odd: 'value' };
  assert.equal(withoutCarwashHooks(untouched), untouched);
  assert.equal(withoutCarwashHooks(undefined), undefined);
  assert.equal(withoutCarwashHooks('text'), 'text');
  assert.equal(withoutCarwashHooks({ Stop: [{ hooks: [ours] }], SessionStart: [{ matcher: 'startup|clear', hooks: [ours] }] }), undefined);
  assert.deepEqual(withoutCarwashHooks({ Stop: [{ hooks: [theirs] }, { hooks: [ours] }], Empty: [], Odd: 'value' }), { Stop: [{ hooks: [theirs] }], Empty: [], Odd: 'value' });
  assert.deepEqual(withoutCarwashHooks({ Stop: [{ matcher: 'x', hooks: [theirs, ours] }] }), { Stop: [{ matcher: 'x', hooks: [theirs] }] });
  assert.equal(isCarwashHook('node "C:/Users/John Smith/.carwash/app/bin/carwash.mjs" hook'), true);
  assert.equal(isCarwashHook('/n/node /h/carwash.mjs statusline'), false);
  assert.equal(isCarwashCommand('/n/node /h/carwash.mjs hook'), false);
});

test('a /wash command the user already has is never replaced', () => {
  for (const place of ['skills/wash/SKILL.md', 'commands/wash.md']) {
    const { env, file, home } = sandbox('{\n  "model": "opus"\n}\n');
    const theirs = join(env.CLAUDE_CONFIG_DIR, place);
    mkdirSync(join(theirs, '..'), { recursive: true });
    writeFileSync(theirs, '---\ndescription: my own wash\n---\nWash the dishes.\n');
    assert.throws(() => install(env), (error) => error instanceof UserError && /already have a \/wash command/.test(error.message));
    assert.equal(read(file), '{\n  "model": "opus"\n}\n');
    assert.equal(read(theirs), '---\ndescription: my own wash\n---\nWash the dishes.\n');
    assert.equal(existsSync(home), false);
  }

  // Put there after install: uninstall leaves it, and says so.
  const { env } = sandbox('{}');
  install(env);
  writeFileSync(skillFile(env), 'Wash the dishes.\n');
  const plan = planUninstall({ env });
  assert.match(describeUninstall(plan), /Leave the \/wash command at .* alone \(not Carwash's\)/);
  applyUninstall(plan);
  assert.equal(read(skillFile(env)), 'Wash the dishes.\n');
});

test('uninstall keeps other files in the skill folder and counts waiting briefs', () => {
  const { env, home } = sandbox('{}');
  install(env);
  const extra = join(env.CLAUDE_CONFIG_DIR, 'skills', 'wash', 'notes.md');
  writeFileSync(extra, 'mine');
  mkdirSync(join(home, 'pending'), { recursive: true });
  writeFileSync(join(home, 'pending', 'abc123.json'), '{}');
  writeFileSync(join(home, 'pending', 'def456.json'), '{}');
  assert.match(describeUninstall(planUninstall({ env })), /Delete .*, including 2 waiting briefs/);
  uninstall(env);
  assert.deepEqual(readdirSync(join(env.CLAUDE_CONFIG_DIR, 'skills', 'wash')), ['notes.md']);
  assert.equal(existsSync(home), false);
});

test('installing twice changes nothing more and still restores the true original', () => {
  const original = '{\n  "statusLine": {"type": "command", "command": "mine.sh"}\n}\n';
  const { env, file, home } = sandbox(original);
  const first = install(env);
  const afterFirst = read(file);
  assert.match(describeInstall(planInstall({ env })), /already there/);
  const second = install(env);
  assert.equal(read(file), afterFirst);
  assert.equal(second.installedAt, first.installedAt);
  assert.equal(second.statusLine.original.command, 'mine.sh');
  assert.deepEqual(ourHooks(json(file)), ALL_HOOKS);
  assert.equal(read(join(home, 'backup', 'settings.json')), original);
  uninstall(env);
  assert.equal(read(file), original);
});

test('reinstalling over edited settings never restores a stale backup', () => {
  const { env, file } = sandbox('{\n  "model": "opus"\n}\n');
  install(env);
  writeFileSync(file, JSON.stringify({ ...json(file), theme: 'dark' }, null, 2) + '\n');
  install(env);
  install(env);
  uninstall(env);
  assert.deepEqual(json(file), { model: 'opus', theme: 'dark' });
});

test('settings Carwash cannot safely edit are refused untouched', () => {
  for (const bad of ['{ "model": "opus", }', 'not json', '[]', 'null', '{"statusLine": "something"}', '{"statusLine": {"type": "other"}}', '{"hooks": []}', '{"hooks": "x"}', '{"hooks": {"Stop": {}}}']) {
    const { env, file, home } = sandbox(bad);
    assert.throws(() => install(env), UserError);
    assert.equal(read(file), bad);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(skillFile(env)), false);
  }
});

test('uninstall refuses to guess when the settings file is unreadable', () => {
  const { env, file, home } = sandbox('{\n  "model": "opus"\n}\n');
  install(env);
  writeFileSync(file, '{ broken');
  assert.throws(() => uninstall(env), UserError);
  assert.equal(read(file), '{ broken');
  assert.ok(existsSync(join(home, 'install.json')));
});

test('uninstall works without an install record', () => {
  const { env, file } = sandbox();
  install(env);
  const kept = { model: 'opus', statusLine: json(file).statusLine, hooks: json(file).hooks };
  writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
  writeFileSync(join(env.CARWASH_HOME, 'install.json'), 'corrupt');
  uninstall(env);
  assert.deepEqual(json(file), { model: 'opus' });
  assert.equal(existsSync(env.CARWASH_HOME), false);
});

test('uninstall only ever deletes a Carwash folder', () => {
  const stray = sandbox('{}');
  mkdirSync(stray.home, { recursive: true });
  writeFileSync(join(stray.home, 'precious.txt'), 'keep me');
  const plan = planUninstall({ env: stray.env });
  assert.equal(plan.removeHome, false);
  applyUninstall(plan);
  assert.equal(read(join(stray.home, 'precious.txt')), 'keep me');

  assert.equal(planUninstall({ env: { ...stray.env, CARWASH_HOME: homedir() } }).removeHome, false);
});

test('a symlinked settings file stays a symlink', { skip: !posix }, () => {
  const { root, env, file } = sandbox();
  const real = join(root, 'dotfiles-settings.json');
  writeFileSync(real, '{\n  "model": "opus"\n}\n');
  symlinkSync(real, file);
  install(env);
  assert.ok(lstatSync(file).isSymbolicLink());
  assert.ok(isCarwashCommand(json(real).statusLine.command));
  uninstall(env);
  assert.ok(lstatSync(file).isSymbolicLink());
  assert.equal(read(real), '{\n  "model": "opus"\n}\n');
});

test('Carwash storage is private and the settings file keeps its permissions', { skip: !posix }, () => {
  const { env, file, home } = sandbox('{}');
  writeFileSync(file, '{}', { mode: 0o644 });
  const mode = (path) => statSync(path).mode & 0o777;
  const before = mode(file);
  install(env);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(join(home, 'backup')), 0o700);
  assert.equal(mode(join(home, 'install.json')), 0o600);
  assert.equal(mode(join(home, 'backup', 'settings.json')), 0o600);
  assert.equal(mode(file), before);
});

test('the command written to settings is safe for the shell that will run it', () => {
  assert.equal(
    statusLineCommand({ nodePath: '/usr/local/bin/node', scriptPath: '/home/u/.carwash/app/bin/carwash.mjs', platform: 'linux' }),
    '/usr/local/bin/node /home/u/.carwash/app/bin/carwash.mjs statusline',
  );
  assert.equal(
    statusLineCommand({ nodePath: '/Users/a b/node', scriptPath: "/Users/a b/it's/carwash.mjs", platform: 'darwin' }),
    `'/Users/a b/node' '/Users/a b/it'\\''s/carwash.mjs' statusline`,
  );
  assert.equal(
    statusLineCommand({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\Users\\u\\.carwash\\app\\bin\\carwash.mjs', platform: 'win32' }),
    'node C:/Users/u/.carwash/app/bin/carwash.mjs statusline',
  );
  assert.equal(
    statusLineCommand({ nodePath: 'node', scriptPath: 'C:\\Users\\John Smith\\.carwash\\app\\bin\\carwash.mjs', platform: 'win32' }),
    'node "C:/Users/John Smith/.carwash/app/bin/carwash.mjs" statusline',
  );
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.ok(isCarwashCommand(statusLineCommand({ nodePath: '/n/node', scriptPath: '/h/a b/carwash.mjs', platform })));
  }
  assert.equal(isCarwashCommand('~/.claude/statusline.sh'), false);
  assert.equal(isCarwashCommand(undefined), false);
});

test('command line: install asks first, and the installed status line runs', () => {
  const { env, file, home } = sandbox('{\n  "model": "opus"\n}\n');
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' }, input: '' });

  // No terminal and no --yes: explain, change nothing.
  let result = run('install');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /will make these changes/);
  assert.match(result.stderr, /Re-run with --yes/);
  assert.equal(read(file), '{\n  "model": "opus"\n}\n');
  assert.equal(existsSync(home), false);

  result = run('install', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Installed\./);

  // The installed hook command runs, exactly as written in settings.
  const hookCommand = json(file).hooks.Stop[0].hooks[0].command;
  const hooked = posix
    ? spawnSync('/bin/sh', ['-c', hookCommand], { encoding: 'utf8', input: '{"hook_event_name":"Stop","session_id":"S1"}', env })
    : spawnSync(process.execPath, [join(home, 'app', 'bin', 'carwash.mjs'), 'hook'], { encoding: 'utf8', input: '{"hook_event_name":"Stop","session_id":"S1"}', env });
  assert.equal(hooked.status, 0, hooked.stderr);
  assert.equal(hooked.stdout + hooked.stderr, '');

  // Run the installed copy exactly as written in settings.
  const payload = JSON.stringify({ context_window: { context_window_size: 200_000, used_percentage: 68 } });
  const command = json(file).statusLine.command;
  const shown = posix
    ? spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', input: payload, env: { ...env, NO_COLOR: '1', TERM_PROGRAM: 'xterm' } })
    : spawnSync(process.execPath, [join(home, 'app', 'bin', 'carwash.mjs'), 'statusline'], { encoding: 'utf8', input: payload, env: { ...env, NO_COLOR: '1', TERM_PROGRAM: 'xterm' } });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, 'session context ~136k  [██████████░░░░░]  /wash to compress & save context, then /clear keeps compressed context\n');

  result = run('uninstall', '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(file), '{\n  "model": "opus"\n}\n');
  assert.equal(existsSync(home), false);

  assert.equal(run('--version').stdout.trim(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(run('nonsense').status, 2);
});
