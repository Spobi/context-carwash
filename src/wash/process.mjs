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
