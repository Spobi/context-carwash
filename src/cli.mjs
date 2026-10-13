import { createInterface } from 'node:readline';
import { applyInstall, applyUninstall, describeInstall, describeUninstall, packageVersion, planInstall, planUninstall } from './install/install.mjs';
import { UserError } from './install/settings.mjs';
import { render } from './statusline/render.mjs';
import { statusline } from './statusline/run.mjs';

const HELP = `Context Carwash: a quiet context meter for Claude Code.

Usage: carwash <command>

  install [--yes]     Add the context meter to Claude Code's status line
  uninstall [--yes]   Undo everything install did
  preview             Print sample meters in this terminal
  --version           Print the version

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
  out.push('', `This window (${columns + 4} columns), before any reply has arrived, then at 68%:`);
  out.push(`  ${render({}, { env, columns }).text}`, `  ${render(sample(68), { env, columns }).text}`);
  stdout.write(out.join('\n') + '\n');
}

export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  const yes = rest.includes('--yes') || rest.includes('-y');
  try {
    switch (command) {
      case 'statusline':
        stdout.write((await statusline({ input: await readAll(stdin), env })) + '\n');
        return 0;
      case 'install': {
        const plan = planInstall({ env });
        stdout.write(describeInstall(plan) + '\n\n');
        if (!(await confirm('Proceed?', { yes, stdin, stdout }))) {
          stdout.write('Nothing was changed.\n');
          return 1;
        }
        applyInstall(plan);
        stdout.write('Installed. The meter appears in Claude Code after your next message, or when you start a new session.\n');
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
