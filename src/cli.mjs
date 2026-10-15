import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { applyInstall, applyUninstall, describeInstall, describeUninstall, packageVersion, planInstall, planUninstall } from './install/install.mjs';
import { claudeVersion, codexInScope, codexVersion, doctorReport, markErrorsSeen } from './install/doctor.mjs';
import { fetchNotice, refreshNotice, startCheck } from './install/notice.mjs';
import { UserError } from './install/settings.mjs';
import { isNewer, latestVersion, runRelease } from './install/update.mjs';
import { errorLogPath, installRecordPath, welcomedPath } from './paths.mjs';
import { readJson } from './files.mjs';
import { refreshLedger, totals } from './stats/ledger.mjs';
import { FORM, describeShare, sendShare, shareId, sharePayload, shareReady, statsReport } from './stats/report.mjs';
import { render } from './statusline/render.mjs';
import { statusline } from './statusline/run.mjs';
import { runHook } from './wash/hooks.mjs';

const HELP = `Context Carwash: a quiet context meter and a deliberate fresh start for Claude Code and Codex.

Usage: carwash <command>

  install [--yes]     Add the context meter and /wash to Claude Code, and $wash to Codex if you have it
  uninstall [--yes]   Undo everything install did
  preview             Print sample meters in this terminal
  stats [--share]     Show how much context /wash has saved; --share sends the totals anonymously, after asking
  doctor              Check the install and show recent errors, to paste into a bug report
  --version           Print the version

Inside Claude Code, once installed:

  /wash [light | mid | detailed]   Write a handoff brief (mid if you do not say)
  /clear                           Start fresh with the brief that is ready
  /wash discard                    Drop the brief; /clear is a normal clear again
  /wash load [id]                  Make a waiting brief the one /clear will use
  /wash stats                      The same totals as carwash stats
  /wash help                       Explain the meter and the options

In Codex it is $wash, with the same options. After /clear, the brief loads
with the first message you send. Codex has no meter.

Nothing happens automatically, and nothing about you is ever sent. Once a day a
new session reads Carwash's public page on npm for the newest version and any
warning about yours (CARWASH_NO_UPDATE_CHECK=1 turns that off). install and
doctor read it too. stats --share sends totals only after you say yes.`;

async function readAll(stream) {
  if (stream.isTTY) return '';
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

async function confirm(question, { yes, stdin, stdout }) {
  if (yes) return true;
  if (!stdin.isTTY) throw new UserError('Not running in a terminal, so there is nobody to ask. Re-run with --yes to confirm.');
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function preview(env, stdout) {
  const sample = (pct, size = 200_000) => ({
    context_window: {
      context_window_size: size,
      used_percentage: pct,
      current_usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.round((pct / 100) * size) - 10 },
    },
  });
  const columns = Math.max(20, (stdout.columns ?? 120) - 4);
  const out = [];
  for (const [style, label] of [['ramp', 'Each block keeps its own colour'], ['solid', 'Whole bar takes the colour of the current reading']]) {
    out.push(`${label}:`);
    for (const pct of [3, 25, 45, 60, 68, 75, 90, 99]) out.push(`  ${render(sample(pct), { env, columns: Infinity, barStyle: style }).text}`);
    out.push('');
  }
  out.push('Narrower windows drop detail in this order:');
  for (const width of [120, 100, 80, 60, 30, 10]) out.push(`  ${String(width).padStart(3)} cols  ${render(sample(68), { env, columns: width - 4 }).text}`);
  out.push('', `This window (${columns + 4} columns), before any reply has arrived, then with 136k in use:`);
  out.push(`  ${render({}, { env, columns }).text}`, `  ${render(sample(68), { env, columns }).text}`);
  out.push('', 'While /wash is writing a brief, and once one is ready for /clear:');
  out.push(`  ${render(sample(68), { env, columns, state: { washing: 'mid' } }).text}`);
  out.push(`  ${render(sample(68), { env, columns, state: { ready: { level: 'mid', tokens: 3100 } } }).text}`);
  stdout.write(out.join('\n') + '\n');
}

// A hook must never fail loudly inside someone's session, so its errors go to
// a small private log instead of the screen.
function logError(env, error) {
  try {
    const file = errorLogPath(env);
    const line = `${new Date().toISOString()} ${error?.stack ?? error}\n`;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // no log yet
    }
    if (size > 200_000) writeFileSync(file, line, { mode: 0o600 });
    else appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // nowhere to write it
  }
}

// What to do next, after an install, for each tool it covered.
function installedMessage(plan, env) {
  const welcome = existsSync(welcomedPath(env, 'claude')) ? '' : ' Its first message explains them.';
  const codex = 'choose "Trust all and continue" when it asks about new hooks. Then type $wash when you want a fresh start.';
  if (!plan.codex) return `Installed. Start a new Claude Code session to get the meter and /wash.${welcome}`;
  if (!plan.claude) return `Installed. Start Codex and ${codex}`;
  return ['Installed.', `  Claude Code: start a new session to get the meter and /wash.${welcome}`, `  Codex: start a new session and ${codex}`].join('\n');
}

export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, latest = latestVersion, handOff = runRelease, form = FORM, share = sendShare, notice = fetchNotice, claude = claudeVersion, codex = codexVersion, check = startCheck } = {}) {
  const [command, ...rest] = argv;
  const yes = rest.includes('--yes') || rest.includes('-y');
  try {
    switch (command) {
      case 'statusline':
        stdout.write((await statusline({ input: await readAll(stdin), env })) + '\n');
        return 0;
      case 'hook': {
        let output = null;
        try {
          const version = packageVersion();
          // `carwash hook` is Claude Code's; Codex's hooks run `carwash hook codex`.
          output = runHook({ input: await readAll(stdin), tool: rest[0] ?? 'claude', env, version, onError: (error) => logError(env, error), checkUpdates: () => check(version, { env }) });
        } catch (error) {
          logError(env, error);
        }
        if (output) stdout.write(JSON.stringify(output) + '\n');
        return 0;
      }
      case 'install': {
        // npx may be rerunning an old download. If npm has something newer,
        // that release does the install. Once only: the newer copy is not
        // asked to check again.
        if (!env.CARWASH_HANDED_OFF) {
          const current = packageVersion();
          const newest = await latest({ env });
          if (isNewer(newest, current)) {
            stdout.write(`This is Context Carwash ${current}, and ${newest} is out. Installing ${newest} instead.\n\n`);
            const status = handOff(newest, argv, { env });
            if (status !== null) return status;
            stdout.write(`Could not start ${newest}, so continuing with ${current}. For the newer one: npx context-carwash@latest install\n\n`);
          }
        }
        const plan = planInstall({ env });
        stdout.write(describeInstall(plan) + '\n\n');
        if (!(await confirm('Proceed?', { yes, stdin, stdout }))) {
          stdout.write('Nothing was changed.\n');
          return 1;
        }
        applyInstall(plan);
        // Errors from before this install are not news.
        markErrorsSeen(env);
        stdout.write(`${installedMessage(plan, env)}\n`);
        return 0;
      }
      case 'uninstall': {
        const plan = planUninstall({ env });
        stdout.write(describeUninstall(plan) + '\n\n');
        if (!(await confirm('Proceed?', { yes, stdin, stdout }))) {
          stdout.write('Nothing was changed.\n');
          return 1;
        }
        applyUninstall(plan);
        stdout.write('Uninstalled.\n');
        return 0;
      }
      case 'stats': {
        const sum = totals(refreshLedger(env, { force: true }));
        stdout.write(statsReport(sum) + '\n');
        if (!rest.includes('--share')) return 0;
        stdout.write('\n');
        if (!shareReady(form)) {
          stdout.write('Sharing is not switched on in this version yet. Nothing was sent.\n');
          return 1;
        }
        if (!sum.washes) {
          stdout.write('There is nothing to share yet. Nothing was sent.\n');
          return 1;
        }
        const payload = sharePayload(sum, { shareId: shareId(env), version: packageVersion() });
        stdout.write(describeShare(payload) + '\n\n');
        if (!(await confirm('Send it?', { yes, stdin, stdout }))) {
          stdout.write('Nothing was sent.\n');
          return 1;
        }
        if (!(await share(payload, { form }))) {
          stdout.write('Could not reach the form, so nothing was sent. Try again later.\n');
          return 1;
        }
        stdout.write('Sent. Thank you.\n');
        return 0;
      }
      case 'preview':
        preview(env, stdout);
        return 0;
      case 'doctor': {
        const running = packageVersion();
        const installed = readJson(installRecordPath(env))?.version;
        const newest = await notice(typeof installed === 'string' ? installed : running, { env });
        stdout.write(doctorReport({ env, running, newest, claude: claude({ env }), codex: codexInScope(env) ? codex({ env }) : null }) + '\n');
        markErrorsSeen(env);
        return 0;
      }
      // Started in the background by a session's start, at most once a day.
      case 'update-check':
        await refreshNotice(packageVersion(), { env });
        return 0;
      case '--version':
      case '-v':
      case 'version':
        stdout.write(packageVersion() + '\n');
        return 0;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        stdout.write(HELP + '\n');
        return 0;
      default:
        stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UserError) {
      stderr.write(`carwash: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
