import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageVersion } from '../src/install/install.mjs';
import { capFor, estimateTokens } from '../src/levels.mjs';
import { render } from '../src/statusline/render.mjs';
import { statusline } from '../src/statusline/run.mjs';
import { washState } from '../src/statusline/state.mjs';
import { visibleWidth } from '../src/statusline/terminal.mjs';
import { cleanTitle, composeContext, formatAge, parseReply, stalenessLine } from '../src/wash/brief.mjs';
import { runHook } from '../src/wash/hooks.mjs';
import { isRunning, processStart, sameProcess } from '../src/wash/process.mjs';
import { currentWash, loadUsage, saveUsage } from '../src/wash/session.mjs';
import { claim, purge, readyRecords } from '../src/wash/store.mjs';

const BIN = fileURLToPath(new URL('../bin/carwash.mjs', import.meta.url));
const posix = process.platform !== 'win32';
const hasGit = spawnSync('git', ['--version']).status === 0;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-13T12:00:00Z');

const BRIEF = `# Carwash brief: Fix login redirect

## Core
- Objective: stop the redirect loop after login.
- State: cause found in src/auth/session.js:42; no fix written yet.
- Next: write a failing test in test/auth.test.js.`;

// Two Claude Code processes (two terminals), and a third that starts later.
const A = { pid: 1001, start: 'a' };
const B = { pid: 1002, start: 'b' };
const C = { pid: 1003, start: 'c' };

// A throwaway Carwash home plus project folders, and helpers that play the
// part of Claude Code calling the hooks.
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'carwash-wash-')));
  const env = { CARWASH_HOME: join(root, 'home') };
  const folder = (name) => {
    mkdirSync(join(root, name), { recursive: true });
    return join(root, name);
  };
  const cwd = folder('project');
  const hook = (payload, { me = A, now = NOW, running = () => false, extraEnv = {} } = {}) =>
    runHook({ input: JSON.stringify({ cwd, ...payload }), env: { ...env, ...extraEnv }, now, me, running });
  const slash = (args, options = {}) =>
    hook({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: args, session_id: options.session ?? 'S1', prompt_id: options.prompt ?? 'P1', cwd: options.cwd ?? cwd }, options);
  const stop = (message, options = {}) =>
    hook({ hook_event_name: 'Stop', last_assistant_message: message, session_id: options.session ?? 'S1', prompt_id: options.prompt ?? 'P1', transcript_path: '/t/S1.jsonl', cwd: options.cwd ?? cwd }, options);
  const start = (source, options = {}) =>
    hook({ hook_event_name: 'SessionStart', source, session_id: options.session ?? 'S2', cwd: options.cwd ?? cwd }, options);
  // A whole /wash: the command, then Claude's reply ending the turn.
  const wash = (level = 'light', options = {}) => {
    saveUsage(env, options.session ?? 'S1', { used: options.used ?? 100_000, size: 200_000 });
    slash(level, options);
    return stop(options.reply ?? BRIEF, options);
  };
  const ready = (now = NOW) => readyRecords(env, now);
  const consumed = () => {
    try {
      return readdirSync(join(env.CARWASH_HOME, 'consumed'));
    } catch {
      return [];
    }
  };
  return { root, env, cwd, folder, hook, slash, stop, start, wash, ready, consumed };
}

test('a reply is recognised as a brief by its heading', () => {
  assert.deepEqual(parseReply(BRIEF), { text: BRIEF, title: 'Fix login redirect' });
  // Anything said before the heading is dropped.
  assert.equal(parseReply(`Here is the brief.\n\n${BRIEF}\n`).text, BRIEF);
  // A reply wrapped whole in a code fence loses the fence, but fences inside the brief stay.
  assert.equal(parseReply('```markdown\n' + BRIEF + '\n```').text, BRIEF);
  const fenced = `${BRIEF}\n\n\`\`\`sh\nnpm test\n\`\`\``;
  assert.equal(parseReply(fenced).text, fenced);
  assert.equal(parseReply('## carwash brief - `Tidy` **up**\n\nbody').title, 'Tidy up');

  for (const not of [undefined, null, 42, '', 'I could not write a brief because there is nothing to hand over.', '# Carwash brief: only a title', '# Carwash brief: title\n\n   ']) {
    assert.equal(parseReply(not), null);
  }
});

test('titles are one clean line that is safe to print', () => {
  assert.equal(cleanTitle('  <Fix the\tlogin   bug>  '), 'Fix the login bug');
  assert.equal(cleanTitle('evil\x1b[31m\x07title\nsecond line'), 'evil [31m title second line');
  assert.equal(Array.from(cleanTitle('x'.repeat(200))).length, 60);
  assert.ok(cleanTitle('x'.repeat(200)).endsWith('…'));
  assert.equal(parseReply('# Carwash brief: \n\nbody').title, 'Untitled');
});

test('sizes, caps and ages', () => {
  assert.equal(capFor('light', 136_000), 1360);
  assert.equal(capFor('mid', 136_000), 4080);
  assert.equal(capFor('detailed', 136_000), 13_600);
  assert.equal(capFor('mid', null), null);
  assert.equal(capFor('nonsense', 136_000), null);
  assert.equal(estimateTokens('x'.repeat(350)), 100);
  assert.equal(estimateTokens(''), 0);
  assert.equal(formatAge(20_000), 'just now');
  assert.equal(formatAge(2 * 60_000 + 5000), '2m ago');
  assert.equal(formatAge(14 * HOUR), '14h ago');
  assert.equal(formatAge(50 * HOUR), '2d ago');
  assert.equal(formatAge(-5), 'just now');
});

test('/wash tells Claude the size limit and marks the session as washing', () => {
  const { env, slash } = sandbox();
  saveUsage(env, 'S1', { used: 136_000, size: 200_000 });

  const mid = slash('');
  assert.equal(mid.decision, undefined);
  assert.equal(mid.hookSpecificOutput.hookEventName, 'UserPromptExpansion');
  assert.match(mid.hookSpecificOutput.additionalContext, /level mid\. This session is using about 136k tokens, so the ceiling for this brief is 4080 tokens/);
  assert.match(mid.hookSpecificOutput.additionalContext, /a limit, not a target/);
  assert.deepEqual({ ...currentWash(env, 'S1', NOW), startedAt: 0 }, { promptId: 'P1', level: 'mid', cap: 4080, used: 136_000, size: 200_000, startedAt: 0, rewrites: 0 });

  assert.match(slash('light').hookSpecificOutput.additionalContext, /level light.*1360 tokens/);
  assert.match(slash('DETAILED  focus on the auth bug').hookSpecificOutput.additionalContext, /level detailed.*13600 tokens/);
  assert.equal(currentWash(env, 'S1', NOW).level, 'detailed');

  // Before the first reply there is no reading, so no number is claimed.
  const unknown = slash('mid', { session: 'S9' });
  assert.match(unknown.hookSpecificOutput.additionalContext, /no token ceiling/);
  assert.equal(currentWash(env, 'S9', NOW).cap, null);
});

test('other commands, and anything that is not a hook call, are ignored', () => {
  const { env, hook, ready } = sandbox();
  assert.equal(hook({ hook_event_name: 'UserPromptExpansion', command_name: 'deploy', command_args: 'light', session_id: 'S1' }), null);
  assert.equal(hook({ hook_event_name: 'PreToolUse', session_id: 'S1' }), null);
  for (const input of ['', 'not json', 'null', '[]', '42']) assert.equal(runHook({ input, env, me: A }), null);
  assert.equal(currentWash(env, 'S1', NOW), null);
  assert.equal(ready().length, 0);
});

test("Claude's reply to /wash is saved as a brief owned by that terminal", () => {
  const { env, cwd, wash, ready } = sandbox();
  const result = wash('mid', { used: 136_000 });
  assert.equal(
    result.systemMessage,
    'Brief ready ✓ mid ~61 of 4.1k cap. Type /clear to start fresh with it. This is not a normal clear: your brief carries over. Old session stays in /resume.',
  );
  assert.equal(result.hookSpecificOutput, undefined);

  const [record] = ready();
  assert.match(record.id, /^[0-9a-f]{6}$/);
  assert.deepEqual(
    { ...record, id: '', createdAt: '' },
    {
      id: '',
      version: 1,
      state: 'ready',
      createdAt: '',
      level: 'mid',
      title: 'Fix login redirect',
      tokens: 61,
      cap: 4080,
      used: 136_000,
      overCap: false,
      source: { sessionId: 'S1', transcriptPath: '/t/S1.jsonl', cwd, worktree: cwd, branch: null, head: null, dirty: null },
      owner: { pid: 1001, start: 'a', sessionId: 'S1' },
      brief: BRIEF,
    },
  );
  assert.equal(record.createdAt, new Date(NOW).toISOString());
  assert.equal(currentWash(env, 'S1', NOW), null);

  if (posix) {
    const mode = (path) => statSync(path).mode & 0o777;
    assert.equal(mode(join(env.CARWASH_HOME, 'pending')), 0o700);
    assert.equal(mode(join(env.CARWASH_HOME, 'pending', `${record.id}.json`)), 0o600);
    assert.equal(mode(join(env.CARWASH_HOME, 'sessions')), 0o700);
  }
});

test('a turn ending is only a wash when /wash asked for one', () => {
  const { env, slash, stop, ready } = sandbox();
  // No wash in progress: an ordinary reply, even one that looks like a brief.
  assert.equal(stop('All done.'), null);
  assert.equal(stop(BRIEF), null);
  assert.equal(ready().length, 0);

  // The wash was interrupted and a later prompt's turn ended instead.
  slash('mid');
  assert.equal(stop(BRIEF, { prompt: 'P2' }), null);
  assert.equal(currentWash(env, 'S1', NOW), null);
  assert.equal(ready().length, 0);

  // Another session's wash is not this session's.
  slash('mid', { session: 'S1' });
  assert.equal(stop(BRIEF, { session: 'S7' }), null);
  assert.ok(currentWash(env, 'S1', NOW));

  // A wash nobody finished is forgotten after a while.
  assert.equal(stop(BRIEF, { now: NOW + 16 * 60_000 }), null);
  assert.equal(ready().length, 0);
});

test('a reply that is not a brief saves nothing and says so', () => {
  const { env, slash, stop, ready } = sandbox();
  slash('mid');
  const result = stop('There is nothing in this conversation to hand over yet.');
  assert.match(result.systemMessage, /not a brief, so nothing was saved/);
  assert.equal(ready().length, 0);
  assert.equal(currentWash(env, 'S1', NOW), null);
});

test('a brief over its cap is sent back for shortening, and never kept silently', () => {
  const { env, slash, stop, ready } = sandbox();
  saveUsage(env, 'S1', { used: 2000, size: 200_000 }); // light cap: 20 tokens
  slash('light');

  const first = stop(BRIEF);
  assert.equal(first.systemMessage, undefined);
  assert.equal(first.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(first.hookSpecificOutput.additionalContext, /about 61 tokens, over the 20-token ceiling for light\. Send it again shortened/);
  assert.equal(ready().length, 0);

  // The shorter rewrite fits and is saved as usual.
  const short = '# Carwash brief: Fix login\n\n## Core\n- Next: test/auth.test.js';
  assert.equal(stop(short).systemMessage.startsWith('Brief ready ✓ light ~18 of 20 cap.'), true);
  assert.equal(ready()[0].overCap, false);

  // Still too long after two rewrites: kept, and the message says it is over.
  slash('light');
  assert.ok(stop(BRIEF).hookSpecificOutput);
  assert.ok(stop(BRIEF).hookSpecificOutput);
  const kept = stop(BRIEF);
  assert.match(kept.systemMessage, /^Brief ready ✓ light ~61, which is over the 20 cap even after asking for a shorter one\. Type \/clear/);
  assert.equal(ready().length, 1);
  assert.equal(ready()[0].overCap, true);
  assert.equal(currentWash(env, 'S1', NOW), null);
});

test('/wash then /clear: the fresh session starts with the brief, once', () => {
  const { env, wash, start, ready, consumed } = sandbox();
  wash('light');
  const [record] = ready();

  const result = start('clear', { now: NOW + 2 * 60_000 });
  assert.equal(
    result.systemMessage,
    "Loaded your Carwash brief (light ~61, 2m ago), down from ~100k in the old session. That size is the brief alone; the meter also counts Claude Code's own baseline.",
  );
  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = result.hookSpecificOutput.additionalContext;
  assert.ok(context.startsWith('# Carwash handoff\n'));
  assert.match(context, /light, written 2m ago/);
  assert.match(context, /read that file in full before you reply/);
  assert.ok(context.endsWith(BRIEF));
  // The brief's Core has to land inside the 2,000 characters Claude Code previews.
  assert.ok(context.indexOf('- Next:') < 1500);

  assert.equal(ready().length, 0);
  assert.deepEqual(consumed(), [`${record.id}.json`]);
  const kept = JSON.parse(readFileSync(join(env.CARWASH_HOME, 'consumed', `${record.id}.json`), 'utf8'));
  assert.equal(kept.state, 'consumed');
  assert.equal(kept.consumedBy, 'S2');
  assert.equal(kept.owner, null);
  assert.equal(kept.brief, BRIEF);

  // The next /clear is a normal clear again.
  assert.equal(start('clear', { session: 'S3' }), null);
});

test('a plain /clear, and every other kind of session start, is left alone', () => {
  const { wash, start, ready } = sandbox();
  // Nothing waiting at all.
  for (const source of ['startup', 'clear', 'resume', 'compact', 'fork']) assert.equal(start(source), null);

  wash('light');
  // A resumed, compacted or forked conversation has its own history.
  for (const source of ['resume', 'compact', 'fork']) assert.equal(start(source), null);
  // /clear in a different terminal is that terminal's own business.
  assert.equal(start('clear', { me: B }), null);
  // Same pid, different process: the number was reused.
  assert.equal(start('clear', { me: { pid: A.pid, start: 'later' } }), null);
  assert.equal(ready().length, 1);
  assert.deepEqual(ready()[0].owner, { pid: 1001, start: 'a', sessionId: 'S1' });
});

test('a new terminal picks up the one brief left for its folder', () => {
  const { wash, start, ready, folder } = sandbox();
  wash('mid');

  // Started somewhere else: not its brief.
  assert.equal(start('startup', { me: C, cwd: folder('elsewhere') }), null);
  assert.equal(ready().length, 1);

  const result = start('startup', { me: C, now: NOW + 3 * HOUR });
  assert.match(result.systemMessage, /^Loaded your Carwash brief \(mid ~61, 3h ago\), down from ~100k in the old session\./);
  assert.ok(result.hookSpecificOutput.additionalContext.endsWith(BRIEF));
  assert.equal(ready().length, 0);
});

test('when it is not certain which brief is meant, nothing is loaded and the user is told', () => {
  const { wash, start, ready } = sandbox();
  wash('mid');
  const [record] = ready();

  // The terminal that wrote it is still open.
  let result = start('startup', { me: C, running: () => true });
  assert.equal(result.hookSpecificOutput, undefined);
  assert.equal(
    result.systemMessage,
    `Carwash: a brief is waiting for this folder. It was not loaded because the session that wrote it is still open. ${record.id} "Fix login redirect" (mid ~61, just now). To use it: /wash load ${record.id}, then /clear.`,
  );

  // Over 12 hours old.
  result = start('startup', { me: C, now: NOW + 13 * HOUR });
  assert.match(result.systemMessage, /It was not loaded because it is over 12 hours old\. .*13h ago/);

  // More than one waiting.
  wash('light', { session: 'S5', me: B, prompt: 'P5', now: NOW + 60_000, reply: BRIEF.replace('Fix login redirect', 'Refactor store') });
  result = start('startup', { me: C, now: NOW + HOUR });
  assert.equal(result.hookSpecificOutput, undefined);
  assert.match(
    result.systemMessage,
    /^Carwash: 2 briefs are waiting for this folder\. None was loaded because there is more than one\. .*"Refactor store".* · .*"Fix login redirect".*To use one: \/wash load <id>, then \/clear\.$/,
  );
  assert.equal(ready(NOW + HOUR).length, 2);
});

test('a brief expires after 48 hours', () => {
  const { env, wash, start, ready } = sandbox();
  wash('mid');
  const [record] = ready();
  assert.equal(ready(NOW + 49 * HOUR).length, 0);
  assert.equal(start('startup', { me: C, now: NOW + 49 * HOUR }), null);
  assert.equal(existsSync(join(env.CARWASH_HOME, 'pending', `${record.id}.json`)), false);
});

test('a process that has just started owns nothing, whatever its pid', () => {
  const { wash, start, ready, folder } = sandbox();
  // Where start times cannot be read, the pid is all there is to go on.
  const old = { pid: 2001, start: null };
  wash('mid', { me: old });
  assert.deepEqual(ready()[0].owner, { pid: 2001, start: null, sessionId: 'S1' });

  // A later process is handed the same pid and starts in another folder.
  const reborn = { pid: 2001, start: null };
  assert.equal(start('startup', { me: reborn, cwd: folder('elsewhere') }), null);
  assert.equal(ready()[0].owner, null);
  // Its /clear must not deliver the stranger's brief.
  assert.equal(start('clear', { me: reborn, cwd: folder('elsewhere') }), null);
  assert.equal(ready().length, 1);
});

test('unattended sessions never use up a brief', () => {
  const { wash, start, ready } = sandbox();
  wash('mid');
  assert.equal(start('startup', { me: C, extraEnv: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }), null);
  assert.equal(start('startup', { me: C, extraEnv: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }), null);
  assert.equal(ready().length, 1);
  assert.ok(start('startup', { me: C, extraEnv: { CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' } }).hookSpecificOutput);
});

test('a relaunch for one particular brief gets exactly that brief', () => {
  const { wash, start, ready, folder } = sandbox();
  wash('mid');
  wash('light', { session: 'S5', me: B, prompt: 'P5' });
  const target = ready().find((record) => record.level === 'mid');

  assert.equal(start('startup', { me: C, extraEnv: { CARWASH_PENDING: 'ffffff' } }), null);
  const result = start('startup', { me: C, cwd: folder('elsewhere'), running: () => true, extraEnv: { CARWASH_PENDING: target.id } });
  assert.match(result.systemMessage, /^Loaded your Carwash brief \(mid/);
  assert.deepEqual(ready().map((record) => record.level), ['light']);
});

test('two sessions starting at once cannot both receive a brief', () => {
  const { env, wash, ready } = sandbox();
  wash('mid');
  const [record] = ready();
  assert.equal(claim(env, record, 'S2', NOW).state, 'consumed');
  assert.equal(claim(env, record, 'S3', NOW), null);
});

test('washing again replaces the earlier brief from that session', () => {
  const { wash, ready, start } = sandbox();
  wash('light');
  wash('mid', { prompt: 'P2', now: NOW + 60_000, reply: BRIEF.replace('Fix login redirect', 'Second pass') });
  assert.deepEqual(ready(NOW + 60_000).map((record) => [record.level, record.title]), [['mid', 'Second pass']]);

  // A wash in another session of the same terminal takes over the terminal;
  // the earlier brief goes back to waiting for its folder.
  wash('light', { session: 'S4', prompt: 'P3', now: NOW + 120_000, reply: BRIEF.replace('Fix login redirect', 'Other task') });
  const records = ready(NOW + 120_000);
  assert.deepEqual(records.map((record) => [record.title, record.owner?.sessionId ?? null]), [['Other task', 'S4'], ['Second pass', null]]);
  assert.match(start('clear', { now: NOW + 120_000 }).hookSpecificOutput.additionalContext, /Other task/);
});

test('/wash discard drops the brief and never reaches Claude', () => {
  const { env, wash, slash, start, ready } = sandbox();
  wash('mid');
  const [record] = ready();

  const result = slash('discard');
  assert.deepEqual(result, { decision: 'block', reason: `Carwash: discarded brief ${record.id} "Fix login redirect" (mid ~61, just now). /clear is a normal clear again.` });
  assert.equal(ready().length, 0);
  assert.equal(start('clear'), null);
  assert.equal(slash('discard').reason, 'Carwash: no brief is ready in this session, so there was nothing to discard.');

  // A wash left hanging is cancelled too.
  slash('mid');
  slash('discard');
  assert.equal(currentWash(env, 'S1', NOW), null);

  // Another terminal's brief is only dropped by naming it.
  wash('mid', { me: B, session: 'S5', prompt: 'P5' });
  const [theirs] = ready();
  assert.match(slash('discard').reason, new RegExp(`nothing to discard\\. Waiting for this folder: ${theirs.id} .*To drop one: /wash discard <id>\\.$`));
  assert.equal(ready().length, 1);
  assert.match(slash('discard zz').reason, /no waiting brief has the id "zz"/);
  assert.match(slash(`discard ${theirs.id.slice(0, 3)}`).reason, new RegExp(`^Carwash: discarded brief ${theirs.id} `));
  assert.equal(ready().length, 0);
});

test('/wash load makes a waiting brief the one /clear will use', () => {
  const { wash, slash, start, ready, folder } = sandbox();
  assert.equal(slash('load').reason, 'Carwash: no briefs are waiting for this folder.');
  assert.match(slash('load abc123').reason, /no brief has the id "abc123"/);

  // Terminal B left a brief; terminal A takes it by id.
  wash('mid', { me: B, session: 'S5', prompt: 'P5' });
  const [theirs] = ready();
  assert.equal(start('clear'), null);
  const loaded = slash(`load ${theirs.id}`);
  assert.equal(loaded.decision, 'block');
  assert.equal(loaded.reason, `Carwash: brief ${theirs.id} "Fix login redirect" (mid ~61, just now) is ready ✓ Type /clear to start fresh with it.`);
  assert.deepEqual(ready()[0].owner, { pid: 1001, start: 'a', sessionId: 'S1' });
  assert.equal(start('clear', { me: B }), null);
  assert.match(start('clear').systemMessage, /^Loaded your Carwash brief/);

  // A delivered brief is kept for a day and can be loaded again.
  assert.equal(ready().length, 0);
  assert.match(slash(`load ${theirs.id.slice(0, 4)}`).reason, /is ready ✓/);
  assert.equal(ready()[0].state, 'ready');
  assert.equal(ready()[0].consumedAt, undefined);
  assert.match(start('clear').hookSpecificOutput.additionalContext, /Fix login redirect/);

  // Without an id: the only one waiting for this folder, or a list to pick from.
  wash('light', { me: B, session: 'S6', prompt: 'P6', reply: BRIEF.replace('Fix login redirect', 'One') });
  assert.match(slash('load').reason, /"One" .* is ready ✓/);
  wash('light', { me: B, session: 'S7', prompt: 'P7', reply: BRIEF.replace('Fix login redirect', 'Two') });
  wash('light', { me: C, session: 'S8', prompt: 'P8', now: NOW + 1000, reply: BRIEF.replace('Fix login redirect', 'Three') });
  assert.match(slash('load', { now: NOW + 1000 }).reason, /^Carwash: more than one brief is waiting for this folder: .*"Three".* · .*"Two".*Pick one: \/wash load <id>\.$/);

  // Loading another hands the first one back instead of losing it.
  const two = ready().find((record) => record.title === 'Two');
  slash(`load ${two.id}`);
  assert.deepEqual(ready().map((record) => [record.title, record.owner?.pid ?? null]).sort(), [['One', null], ['Three', 1003], ['Two', 1001]]);

  // A brief from another folder can be loaded on purpose, and says where it is from.
  const other = folder('elsewhere');
  const note = slash(`load ${two.id}`, { cwd: other }).reason;
  assert.match(note, /Note: it was written in a different folder, /);
  assert.match(start('clear', { cwd: other }).systemMessage, /This brief was written in a different folder: /);
});

test('unknown /wash arguments explain themselves instead of reaching Claude', () => {
  const { env, slash } = sandbox();
  assert.deepEqual(slash('bogus'), { decision: 'block', reason: 'Carwash: /wash does not know "bogus". Usage: /wash [light | mid | detailed], /wash discard [id], /wash load [id], /wash stats, /wash help' });
  assert.equal(currentWash(env, 'S1', NOW), null);
});

test('/wash help explains the meter and the options without reaching Claude', () => {
  const { env, slash, wash, ready } = sandbox();
  saveUsage(env, 'S1', { used: 136_000, size: 200_000 });
  const help = slash('help');
  assert.equal(help.decision, 'block');
  assert.equal(
    help.reason,
    [
      'Carwash: /wash compresses this conversation into a short brief. Your next /clear then starts a fresh session that begins with it, and the old session stays in /resume.',
      '',
      '  /wash light           goal, where things stand, next step, up to 1.4k tokens',
      '  /wash mid             adds decisions, constraints, pitfalls (the default), up to 4.1k tokens',
      '  /wash detailed        adds reasoning, history, test results, a checklist, up to 13.6k tokens',
      '  /wash discard         drop the brief; /clear is a normal clear again',
      '  /wash load [id]       make a waiting brief the one /clear uses',
      '',
      "The status line shows how many tokens this conversation is using, and the bar shows how close that is to the model's limit.",
      'Writing a brief is an ordinary Claude reply, so it uses tokens. help, discard and load do not.',
      '',
      `Carwash ${packageVersion()}. Something not working? Run in a terminal: npx context-carwash doctor`,
    ].join('\n'),
  );
  // Before the first reply there is no reading, so no sizes are claimed.
  assert.doesNotMatch(slash('HELP', { session: 'S9' }).reason, /up to/);

  // It leaves a wash in progress, and a ready brief, alone.
  slash('mid');
  slash('help');
  assert.equal(currentWash(env, 'S1', NOW).level, 'mid');
  wash('light');
  slash('help');
  assert.equal(ready().length, 1);
});

test('the first session after install is welcomed, once', () => {
  const { env, start, wash, ready } = sandbox();
  // No install record: nobody to welcome (and every other test runs this way).
  assert.equal(start('startup'), null);

  mkdirSync(env.CARWASH_HOME, { recursive: true });
  writeFileSync(join(env.CARWASH_HOME, 'install.json'), '{}');
  // A run nobody is watching does not use it up.
  assert.equal(start('startup', { extraEnv: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }), null);
  // Nor does a resumed conversation.
  assert.equal(start('resume'), null);

  const first = start('startup');
  assert.match(first.systemMessage, /^Context Carwash installed ✓ \(shown once\)\n/);
  assert.match(first.systemMessage, /\/wash, then \/clear/);
  assert.equal(first.hookSpecificOutput, undefined);
  assert.equal(start('startup', { session: 'S3' }), null);
  assert.equal(start('clear', { session: 'S4' }), null);

  // A brief to deliver comes first, and the welcome waits for a quiet start.
  rmSync(join(env.CARWASH_HOME, 'welcomed'));
  wash('light');
  assert.match(start('clear').systemMessage, /^Loaded your Carwash brief/);
  assert.equal(ready().length, 0);
  assert.match(start('clear', { session: 'S5' }).systemMessage, /^Context Carwash installed/);
});

test('the loaded message leaves out the old size when it was never known', () => {
  const { env, slash, stop, start } = sandbox();
  slash('light');
  stop(BRIEF);
  assert.equal(
    start('clear', { now: NOW + 60_000 }).systemMessage,
    "Loaded your Carwash brief (light ~61, 1m ago). That size is the brief alone; the meter also counts Claude Code's own baseline.",
  );
  assert.equal(loadUsage(env, 'S1'), null);
});

test('the fresh session is told when the repository has moved', { skip: !hasGit }, () => {
  const { cwd, wash, start } = sandbox();
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  const before = git('rev-parse', 'HEAD').stdout.trim();

  wash('mid');
  // Nothing moved: no extra line.
  const same = wash('mid', { prompt: 'P2' }) && start('clear');
  assert.doesNotMatch(same.systemMessage, /Repo changed/);
  assert.doesNotMatch(same.hookSpecificOutput.additionalContext, /Repo changed/);

  wash('mid', { prompt: 'P3' });
  writeFileSync(join(cwd, 'a.txt'), 'two\n');
  git('commit', '-qam', 'second');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(cwd, 'b.txt'), 'new\n');
  const after = git('rev-parse', 'HEAD').stdout.trim();

  const moved = start('clear');
  const line = `Repo changed since this brief: HEAD ${before.slice(0, 7)}→${after.slice(0, 7)}, branch main→feature, there are new uncommitted changes.`;
  assert.ok(moved.systemMessage.includes(line), moved.systemMessage);
  assert.ok(moved.hookSpecificOutput.additionalContext.includes(`\n${line}\n`));
});

test('staleness is only reported where it is known', () => {
  const source = { worktree: '/w', branch: 'main', head: 'aaaaaaaaaaaa', dirty: false };
  assert.equal(stalenessLine(source, { ...source }), null);
  assert.equal(stalenessLine(source, { ...source, head: null, branch: null, dirty: null }), null);
  assert.equal(stalenessLine({ worktree: '/w', branch: null, head: null, dirty: null }, source), null);
  assert.equal(stalenessLine(null, source), null);
  assert.equal(stalenessLine({ ...source, dirty: true }, source), 'Repo changed since this brief: the uncommitted changes are gone.');
  assert.equal(stalenessLine(source, { ...source, branch: null, head: 'bbbbbbbbbbbb' }), 'Repo changed since this brief: HEAD aaaaaaa→bbbbbbb, branch main→detached.');
  assert.equal(stalenessLine(source, { ...source, worktree: '/other' }), 'This brief was written in a different folder: /w.');
  assert.match(composeContext({ level: 'mid', createdAt: new Date(NOW).toISOString(), brief: 'B' }, NOW, 'STALE'), /\nSTALE\n\n---\n\nB$/);
});

test('delivered briefs and old notes are cleared out in time', () => {
  const { env, wash, start, consumed } = sandbox();
  wash('mid');
  start('clear');
  assert.equal(consumed().length, 1);
  purge(env, NOW + 23 * HOUR);
  assert.equal(consumed().length, 1);
  purge({ ...env, CARWASH_RETAIN_HOURS: '1' }, NOW + 2 * HOUR);
  assert.equal(consumed().length, 0);

  wash('mid', { prompt: 'P2' });
  start('clear');
  purge({ ...env, CARWASH_RETAIN_HOURS: 'soon' }, NOW + 25 * HOUR);
  assert.equal(consumed().length, 0);

  // Notes for sessions not seen in a week, and stray files, go as well.
  const sessions = join(env.CARWASH_HOME, 'sessions');
  const longAgo = new Date(Date.now() - 8 * 24 * HOUR);
  utimesSync(join(sessions, 'S1.usage.json'), longAgo, longAgo);
  saveUsage(env, 'S2', { used: 5, size: 10 });
  const stray = join(env.CARWASH_HOME, 'pending', '.123.abc.carwash-tmp');
  writeFileSync(stray, 'half-written');
  utimesSync(stray, longAgo, longAgo);
  purge(env, Date.now());
  assert.deepEqual(readdirSync(sessions), ['S2.usage.json']);
  assert.equal(existsSync(stray), false);
});

test('damaged or foreign files in the store are skipped, not trusted', () => {
  const { env, wash, start, ready } = sandbox();
  wash('mid');
  const pending = join(env.CARWASH_HOME, 'pending');
  writeFileSync(join(pending, 'broken.json'), '{ not json');
  writeFileSync(join(pending, 'aaaaaa.json'), JSON.stringify({ id: 'zzzzzz', brief: 'x', createdAt: new Date(NOW).toISOString() }));
  writeFileSync(join(pending, 'bbbbbb.json'), JSON.stringify({ id: 'bbbbbb', createdAt: new Date(NOW).toISOString() }));
  writeFileSync(join(pending, 'notes.txt'), 'hello');
  assert.equal(ready().length, 1);
  assert.match(start('clear').systemMessage, /^Loaded your Carwash brief/);
});

test('session notes ignore ids that are not plain names', () => {
  const { env } = sandbox();
  for (const bad of ['../escape', 'a/b', '', '.hidden', undefined, 42]) {
    saveUsage(env, bad, { used: 5, size: 10 });
    assert.equal(loadUsage(env, bad), null);
  }
  assert.equal(existsSync(join(env.CARWASH_HOME, 'sessions')), false);
  saveUsage(env, 'fc82437e-1cdf-432d-8e53-9b1a9c369709', { used: 5, size: 10 });
  assert.deepEqual(loadUsage(env, 'fc82437e-1cdf-432d-8e53-9b1a9c369709'), { used: 5, size: 10 });
  assert.equal(loadUsage(env, 'never-seen'), null);
});

test('process identity: same pid and start time, and whether it is still running', () => {
  assert.equal(sameProcess({ pid: 5, start: 'x' }, { pid: 5, start: 'x' }), true);
  assert.equal(sameProcess({ pid: 5, start: 'x' }, { pid: 5, start: 'y' }), false);
  assert.equal(sameProcess({ pid: 5, start: null }, { pid: 5, start: 'y' }), true);
  assert.equal(sameProcess({ pid: 5, start: 'x' }, { pid: 6, start: 'x' }), false);
  assert.equal(sameProcess(null, { pid: 5, start: 'x' }), false);

  const mine = { pid: process.pid, start: processStart(process.pid) };
  assert.equal(isRunning(mine), true);
  assert.equal(isRunning(null), false);
  assert.equal(isRunning({ pid: -1 }), false);
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(isRunning({ pid: gone, start: null }), false);
  if (posix) {
    assert.equal(typeof mine.start, 'string');
    // A live pid with someone else's start time is a different process.
    assert.equal(isRunning({ pid: process.pid, start: 'Thu Jan  1 00:00:00 1970' }), false);
  }
});

test('the status line says when a brief is being written and when one is ready', async () => {
  const { env, wash, slash, start } = sandbox();
  const payload = { session_id: 'S1', context_window: { context_window_size: 200_000, used_percentage: 68, current_usage: { input_tokens: 136_000 } } };
  const look = (me = A, session = 'S1') => washState({ ...payload, session_id: session }, { env, now: NOW, me });

  assert.equal(look(), null);
  // The reading is noted for the /wash hook to size the brief from.
  assert.deepEqual(loadUsage(env, 'S1'), { used: 136_000, size: 200_000 });

  slash('mid');
  assert.deepEqual(look(), { washing: 'mid' });
  assert.equal(look(A, 'S9'), null);

  wash('mid');
  assert.deepEqual(look(), { ready: { level: 'mid', tokens: 61 } });
  // Any session in that terminal sees it; other terminals do not.
  assert.deepEqual(look(A, 'S9'), { ready: { level: 'mid', tokens: 61 } });
  assert.equal(look(B), null);

  start('clear');
  assert.equal(look(), null);

  // End to end, under the pid Claude Code reports. The status line reads the
  // real clock, so this brief is written now rather than at NOW, or it would
  // have expired 48 hours after NOW.
  wash('light', { me: { pid: 424_242, start: null }, prompt: 'P2', now: Date.now() });
  const line = await statusline({ input: JSON.stringify(payload), env: { ...env, CLAUDE_PID: '424242', TERM_PROGRAM: 'xterm', NO_COLOR: '1' } });
  assert.equal(line, 'session context ~136k  [██████████░░░░░]  Brief ready ✓ light ~61 · type /clear to start fresh with it. Old session stays in /resume.');
});

test('wash states fit any width, losing detail before overflowing', () => {
  const payload = { context_window: { context_window_size: 200_000, used_percentage: 68 } };
  const env = { TERM_PROGRAM: 'Apple_Terminal', NO_COLOR: '1' };
  const ready = (columns) => render(payload, { env, columns, state: { ready: { level: 'mid', tokens: 3100 } } }).text;
  assert.equal(ready(Infinity), 'session context ~136k  [██████████░░░░░]  Brief ready ✓ mid ~3.1k · type /clear to start fresh with it. Old session stays in /resume.');
  assert.equal(ready(131), 'session context ~136k  [██████████░░░░░]  Brief ready ✓ mid ~3.1k · type /clear to start fresh with it');
  assert.equal(ready(102), 'session context ~136k  [██████████░░░░░]  Brief ready ✓ mid ~3.1k · type /clear to start fresh with it');
  assert.equal(ready(101), 'session context ~136k  [██████████░░░░░]  Brief ready ✓ · /clear to start fresh');
  assert.equal(ready(79), 'session context ~136k  [██████████░░░░░]  Brief ready ✓ · /clear to start fresh');
  assert.equal(ready(78), 'session context ~136k  Brief ready ✓ · /clear to start fresh');
  assert.equal(ready(59), 'session context ~136k  Brief ready ✓');
  assert.equal(ready(35), 'session context ~136k');

  const washing = (columns) => render(payload, { env, columns, state: { washing: 'mid' } }).text;
  assert.equal(washing(Infinity), 'session context ~136k  [██████████░░░░░]  washing…');
  assert.equal(washing(50), 'session context ~136k  [██████████░░░░░]  washing…');
  assert.equal(washing(49), 'session context ~136k  washing…');
  assert.equal(washing(30), 'session context ~136k');

  // The shortest reading, "session context ~136k", is 21 columns: below that nothing can fit.
  for (let columns = 21; columns <= 140; columns++) {
    assert.ok(visibleWidth(ready(columns)) <= columns, `ready overflows at ${columns}`);
    assert.ok(visibleWidth(washing(columns)) <= columns, `washing overflows at ${columns}`);
  }
});

test('carwash hook: the command Claude Code runs, end to end', () => {
  const { env, cwd } = sandbox();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CARWASH)/.test(key)));
  const run = (payload, extra = {}) =>
    spawnSync(process.execPath, [BIN, 'hook'], { input: typeof payload === 'string' ? payload : JSON.stringify({ cwd, ...payload }), encoding: 'utf8', env: { ...clean, ...env, CLAUDE_PID: '424242', ...extra } });
  const json = (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout ? JSON.parse(result.stdout) : null;
  };

  saveUsage(env, 'S1', { used: 136_000, size: 200_000 });
  const begun = json(run({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: 'light', session_id: 'S1', prompt_id: 'P1' }));
  assert.match(begun.hookSpecificOutput.additionalContext, /1360 tokens/);

  assert.equal(json(run({ hook_event_name: 'Stop', session_id: 'S1', prompt_id: 'P0', last_assistant_message: 'unrelated' })), null);
  json(run({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: 'light', session_id: 'S1', prompt_id: 'P1' }));
  const saved = json(run({ hook_event_name: 'Stop', session_id: 'S1', prompt_id: 'P1', last_assistant_message: BRIEF }));
  assert.match(saved.systemMessage, /^Brief ready ✓ light ~61 of 1\.4k cap\./);

  // A headless run in the same folder leaves the brief for a person.
  assert.equal(json(run({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'S2' }, { CLAUDE_PID: '424243', CLAUDE_CODE_SESSION_ATTENDED: '0' })), null);
  const loaded = json(run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'S2' }));
  assert.match(loaded.systemMessage, /^Loaded your Carwash brief/);
  assert.ok(loaded.hookSpecificOutput.additionalContext.endsWith(BRIEF));
  assert.equal(json(run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'S3' })), null);

  // Never fails loudly, whatever arrives.
  for (const input of ['', 'garbage', '{"hook_event_name":"Stop"}', '{"hook_event_name":"SessionStart","source":"clear"}']) {
    const result = run(input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('a failing hook logs privately and stays quiet', { skip: !posix }, () => {
  const { env, cwd } = sandbox();
  // A file where the pending folder should be makes saving the brief fail.
  mkdirSync(env.CARWASH_HOME, { recursive: true });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CARWASH)/.test(key)));
  const run = (payload) => spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8', env: { ...clean, ...env, CLAUDE_PID: '424242' } });
  run({ hook_event_name: 'UserPromptExpansion', command_name: 'wash', command_args: 'light', session_id: 'S1', prompt_id: 'P1' });
  writeFileSync(join(env.CARWASH_HOME, 'pending'), 'in the way');
  const result = run({ hook_event_name: 'Stop', session_id: 'S1', prompt_id: 'P1', last_assistant_message: BRIEF });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.match(readFileSync(join(env.CARWASH_HOME, 'errors.log'), 'utf8'), /^\d{4}-\d\d-\d\dT.*(ENOTDIR|EEXIST)/);
});
