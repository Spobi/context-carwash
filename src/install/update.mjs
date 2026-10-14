import { spawnSync } from 'node:child_process';

// Whether a newer Context Carwash is on npm, and handing over to it, for the
// installer: npx can quietly rerun a copy it downloaded earlier, and people
// should not have to know to type @latest. The daily check behind the update
// notice is in notice.mjs. The meter and /wash never go online themselves.

const LATEST_URL = 'https://registry.npmjs.org/context-carwash/latest';
const TIMEOUT_MS = 3000;

const parse = (version) => {
  const found = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  return found ? found.slice(1).map(Number) : null;
};

// True when `latest` is a later release than `current`. Anything unreadable is
// not newer.
export function isNewer(latest, current) {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The version npm calls latest, or null when it cannot say in time. Offline,
// slow or opted out (CARWASH_NO_UPDATE_CHECK) all mean no answer, never an error.
export async function latestVersion({ env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  if (env.CARWASH_NO_UPDATE_CHECK) return null;
  try {
    const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const { version } = await response.json();
    return parse(version) ? version : null;
  } catch {
    return null;
  }
}

// Run `carwash <args>` from the given release instead of this one, in this
// terminal, so its questions reach the person. Pinned to the exact version, so
// the newer copy finds itself up to date and does not hand off again. Resolves
// to its exit code, or null if npx could not be started.
export function runRelease(version, args, { env = process.env, platform = process.platform } = {}) {
  const npx = platform === 'win32' ? 'npx.cmd' : 'npx';
  // npx.cmd is a batch file, which Windows only runs through a shell.
  const result = spawnSync(npx, ['--yes', `context-carwash@${version}`, ...args], {
    stdio: 'inherit',
    env: { ...env, CARWASH_HANDED_OFF: version },
    shell: platform === 'win32',
  });
  return result.error || result.status === null ? null : result.status;
}
