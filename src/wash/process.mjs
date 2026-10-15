import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The Claude Code process a hook or status line is running under. Every
// session in one terminal shares it, across /clear.
export function claudePid(env = process.env) {
  const pid = Number.parseInt(env.CLAUDE_PID ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : process.ppid;
}

// When a process started, as an opaque string, or null where there is no cheap
// way to ask. Paired with the pid, it tells a process apart from a later one
// that was handed the same number.
export function processStart(pid, platform = process.platform) {
  try {
    if (platform === 'win32') return null;
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Fields after the parenthesised command name; start time is the 22nd overall.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    return (result.status === 0 && result.stdout.trim()) || null;
  } catch {
    return null;
  }
}

// This Claude Code process. The start time is only looked up when asked for:
// on macOS it costs a `ps` run, which the status line should not pay each time.
export function currentProcess(env = process.env, platform = process.platform) {
  const pid = claudePid(env);
  let start;
  return {
    pid,
    get start() {
      if (start === undefined) start = processStart(pid, platform);
      return start;
    },
  };
}

// A process's parent and its command line, or null where it cannot be told or
// the process has gone. On macOS the arguments come back joined by spaces, so
// an argument that contains a space reads as several.
export function processInfo(pid, platform = process.platform) {
  try {
    if (platform === 'win32') return windowsInfo(pid);
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number.parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      return Number.isInteger(ppid) ? { ppid, args } : null;
    }
    const result = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const found = result.status === 0 && /^\s*(\d+)\s+(.*\S)/.exec(result.stdout);
    return found ? { ppid: Number(found[1]), args: found[2].split(/\s+/) } : null;
  } catch {
    return null;
  }
}

// Windows has no quick `ps`, so one PowerShell run reads a process and the
// few above it, and the answers are kept for the rest of this hook call.
const windowsSeen = new Map();
function windowsInfo(pid) {
  if (windowsSeen.has(pid)) return windowsSeen.get(pid);
  windowsSeen.set(pid, null);
  const script =
    `$p=${Number(pid)};$o=@();for($i=0;$i -lt 4 -and $p;$i++){` +
    '$w=Get-CimInstance Win32_Process -Filter "ProcessId=$p";if(-not $w){break};' +
    '$o+=[pscustomobject]@{pid=[int]$p;ppid=[int]$w.ParentProcessId;name=[string]$w.Name;cmd=[string]$w.CommandLine};$p=$w.ParentProcessId};' +
    'ConvertTo-Json -Compress -InputObject @($o)';
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status !== 0) return null;
  for (const row of [JSON.parse(result.stdout)].flat()) {
    if (!Number.isInteger(row?.pid)) continue;
    // The program, then the words after it; the program's path may be quoted.
    const rest = String(row.cmd ?? '').replace(/^\s*("[^"]*"|\S+)\s*/, '');
    windowsSeen.set(row.pid, { ppid: row.ppid, args: [row.name || 'unknown', ...rest.split(/\s+/).filter(Boolean)] });
  }
  return windowsSeen.get(pid);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell', 'cmd']);
const isShell = (program) => SHELLS.has(String(program ?? '').split(/[\\/]/).pop().replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase());

// The Codex process a hook is running under. Like Claude Code, it keeps one
// process across /clear. Codex starts each hook through a shell: on macOS and
// Linux the user's, which usually hands over to the command, so Codex is the
// parent; on Windows cmd.exe, which stays in between. Where a shell is the
// parent, Codex is the shell's parent. Nothing is looked up until it is asked
// for: the hook that runs on every prompt mostly never needs it. Claude Code's
// CLAUDE_PID is ignored, since Codex may have been started from a terminal
// inside Claude Code.
export function codexProcess(platform = process.platform, lookup = processInfo) {
  let pid;
  let info;
  let start;
  const resolve = () => {
    if (pid !== undefined) return;
    pid = process.ppid;
    info = lookup(pid, platform);
    for (let hops = 0; hops < 2 && info && isShell(info.args[0]) && info.ppid > 1; hops++) {
      pid = info.ppid;
      info = lookup(pid, platform);
    }
  };
  return {
    get pid() {
      resolve();
      return pid;
    },
    // Its command line, when it could be read.
    get args() {
      resolve();
      return info?.args ?? null;
    },
    get start() {
      if (start === undefined) start = processStart(this.pid, platform);
      return start;
    },
  };
}

// Codex options that take a value, so the word after one is not a subcommand.
const CODEX_VALUE_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir']);

// The first word of a Codex command line that is not an option: a subcommand
// such as `exec`, or the opening prompt.
export function codexSubcommand(args) {
  for (let i = 1; i < (args?.length ?? 0); i++) {
    const arg = args[i];
    if (arg === '--') return null;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && CODEX_VALUE_OPTIONS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return null;
}

// Whether a Codex command line is a script's run (`codex exec`, `codex
// review`) rather than a person's session. Unknown counts as a person.
export function codexUnattended(args) {
  const command = codexSubcommand(args);
  return command === 'exec' || command === 'e' || command === 'review';
}

// Whether a brief's owner is this very process.
export function sameProcess(owner, me) {
  if (!owner || owner.pid !== me.pid) return false;
  return !owner.start || !me.start || owner.start === me.start;
}

// Whether a brief's owner is still running.
export function isRunning(owner, platform = process.platform) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  if (!owner.start) return true;
  const now = processStart(owner.pid, platform);
  return now === null || now === owner.start;
}
