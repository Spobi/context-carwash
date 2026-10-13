import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { installRecordPath } from '../paths.mjs';
import { render } from './render.mjs';
import { washState } from './state.mjs';
import { availableColumns, visibleWidth } from './terminal.mjs';

const SEPARATOR = ' │ ';
const WRAPPED_TIMEOUT_MS = 5000;

// The shell Claude Code itself would use for a statusLine command, so a
// wrapped command behaves as it did before Carwash was installed.
export function shellFor(command, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return ['/bin/sh', ['-c', command]];
  // Windows: Git Bash when Claude Code is running under it, otherwise PowerShell.
  if (env.MSYSTEM || /bash/i.test(env.SHELL ?? '')) return ['bash', ['-c', command]];
  return ['powershell', ['-NoProfile', '-Command', command]];
}

// Run the user's original status line command with the same stdin. Resolves to
// its stdout, or null if it fails, prints nothing, or takes too long.
export function runWrapped(command, input, { env = process.env, platform = process.platform, timeoutMs = WRAPPED_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const [file, args] = shellFor(command, env, platform);
      // Its own process group, so a hung command can be stopped along with
      // anything the shell started for it.
      child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: platform !== 'win32' });
    } catch {
      resolve(null);
      return;
    }
    // Stop the command and let go of its pipes, so a survivor cannot keep
    // this process alive.
    const stop = () => {
      try {
        if (platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        // already gone
      }
      child.stdout.destroy();
      child.stdin.destroy();
      child.unref();
    };
    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGTERM', onTerm);
      resolve(value);
    };
    const timer = setTimeout(() => {
      stop();
      finish(null);
    }, timeoutMs);
    // Claude Code cancels an in-flight status line when a newer update arrives.
    const onTerm = () => {
      stop();
      process.exit(0);
    };
    process.on('SIGTERM', onTerm);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => finish(null));
    child.on('close', () => finish(out.trim() ? out : null));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Join the user's own status line output (if any) with Carwash's segment.
// Ours goes on their last line when there is room for at least the bar, and
// on a line of its own otherwise.
export function compose(theirs, payload, options = {}) {
  const columns = options.columns ?? availableColumns(options.env ?? process.env);
  const text = (theirs ?? '').replace(/\s+$/, '');
  if (!text) return render(payload, { ...options, columns }).text;

  const lines = text.split(/\r?\n/);
  const last = lines[lines.length - 1];
  const inline = render(payload, { ...options, columns: columns - visibleWidth(last) - visibleWidth(SEPARATOR) });
  if (inline.hasBar) {
    lines[lines.length - 1] = last + SEPARATOR + inline.text;
  } else {
    lines.push(render(payload, { ...options, columns }).text);
  }
  return lines.join('\n');
}

function wrappedCommand(env) {
  try {
    const record = JSON.parse(readFileSync(installRecordPath(env), 'utf8'));
    const command = record?.statusLine?.original?.command;
    return typeof command === 'string' && command.trim() ? command : null;
  } catch {
    return null;
  }
}

// Entry point for `carwash statusline`. Must never fail loudly: a broken
// status line is worse than a missing meter, and the user's own status line
// has to keep working whatever happens to ours.
export async function statusline({ input, env = process.env, platform = process.platform } = {}) {
  let theirs = null;
  try {
    const command = wrappedCommand(env);
    if (command) theirs = await runWrapped(command, input, { env, platform });
  } catch {
    theirs = null;
  }
  try {
    let payload = null;
    try {
      payload = JSON.parse(input);
    } catch {
      // Unparseable input renders as an unknown reading.
    }
    let state = null;
    try {
      state = washState(payload, { env, platform });
    } catch {
      // Without it the meter still renders, minus any word about a brief.
    }
    return compose(theirs, payload, { env, platform, state });
  } catch {
    return (theirs ?? '').replace(/\s+$/, '');
  }
}
