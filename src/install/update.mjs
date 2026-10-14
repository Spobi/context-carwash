// Whether a newer Context Carwash is on npm. Only the installer asks, since
// npx can quietly rerun a copy it downloaded earlier. The meter and /wash never
// use the network.

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

// What the installer says before asking, or null when this is the latest.
export function updateNotice(current, latest) {
  if (!isNewer(latest, current)) return null;
  return [
    `A newer Context Carwash is out: ${latest}. This installer is ${current}.`,
    'To install the newer one, answer no and run:  npx context-carwash@latest install',
  ].join('\n');
}
