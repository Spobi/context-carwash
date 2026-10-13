import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { applyInstall, applyUninstall, describeInstall, describeUninstall, packageVersion, planInstall, planUninstall } from './install/install.mjs';
import { UserError } from './install/settings.mjs';
import { errorLogPath } from './paths.mjs';
import { render } from './statusline/render.mjs';
import { statusline } from './statusline/run.mjs';
import { runHook } from './wash/hooks.mjs';

const HELP = `Context Carwash: a quiet context meter and a deliberate fresh start for Claude Code.

Usage: carwash <command>

  install [--yes]     Add the context meter and the /wash command to Claude Code
  uninstall [--yes]   Undo everything install did
  preview             Print sample meters in this terminal
  --version           Print the version

Inside Claude Code, once installed:

  /wash [light | mid | detailed]   Write a handoff brief (mid if you do not say)
  /clear                           Start fresh with the brief that is ready
  /wash discard                    Drop the brief; /clear is a normal clear again
  /wash load [id]                  Make a waiting brief the one /clear will use

Nothing happens automatically, and nothing leaves this machine.`;

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

export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
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
          output = runHook({ input: await readAll(stdin), env });
        } catch (error) {
          logError(env, error);
        }
        if (output) stdout.write(JSON.stringify(output) + '\n');
        return 0;
      }
      case 'install': {
        const plan = planInstall({ env });
        stdout.write(describeInstall(plan) + '\n\n');
        if (!(await confirm('Proceed?', { yes, stdin, stdout }))) {
          stdout.write('Nothing was changed.\n');
          return 1;
        }
        applyInstall(plan);
        stdout.write('Installed. Start a new Claude Code session to get the meter and /wash.\n');
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
      case 'preview':
        preview(env, stdout);
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
