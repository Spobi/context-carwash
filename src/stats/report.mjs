import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '../files.mjs';
import { shareIdPath } from '../paths.mjs';
import { formatTokens } from '../statusline/render.mjs';

// `carwash stats` and `/wash stats`: the ledger's totals in words, and the
// anonymous share that `carwash stats --share` sends after asking.

const LEVEL_ORDER = ['light', 'mid', 'detailed'];

const tokens = (n) => `~${formatTokens(n)} tokens`;

export function statsReport(sum, { inClaude = false } = {}) {
  if (!sum.washes) {
    return 'Carwash stats: no briefs written yet. Once you have used /wash and /clear, this shows how much context they kept from being sent again.';
  }
  const since = new Date(sum.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const levels = LEVEL_ORDER.filter((name) => sum.levels[name]).map((name) => `${name} ${sum.levels[name]}`).join(' · ');
  const net = sum.notResent - sum.briefCost;
  const row = (label, value) => `  ${label.padEnd(28)}${value}`;
  return [
    `Carwash stats, since ${since} (${sum.days} day${sum.days === 1 ? '' : 's'})`,
    '',
    row('Briefs written', `${sum.washes}${levels ? `  (${levels})` : ''}`),
    row('Started fresh with one', `${sum.delivered}`),
    row('Prompts in fresh sessions', `${sum.prompts}  (${sum.requests} requests to Claude)`),
    row('Context not re-sent', tokens(sum.notResent)),
    row('Spent writing briefs', tokens(sum.briefCost)),
    row(net >= 0 ? 'Net saved' : 'Net cost so far', tokens(Math.abs(net))),
    '',
    'How it is worked out: every request to Claude carries the whole conversation. After a wash, each request in the fresh session starts from the brief instead of the old conversation, and the difference is context that was not sent again. Counting stops where the old session would have compacted on its own.',
    'Claude caches repeated context and charges about a tenth for it, so in money terms the saving is roughly a tenth of these numbers.',
    '',
    inClaude ? 'To share these totals anonymously, run in a terminal: npx context-carwash stats --share' : 'To share these totals anonymously: npx context-carwash stats --share',
  ].join('\n');
}

// --- sharing ---------------------------------------------------------------

// The Google Form shares go to. Each share becomes one row of the form's
// response sheet. Until the form exists, sharing says it is not set up.
export const FORM = {
  action: null, // https://docs.google.com/forms/d/e/<form id>/formResponse
  fields: {
    shareId: null,
    version: null,
    system: null,
    days: null,
    washes: null,
    prompts: null,
    notResent: null,
    briefCost: null,
  },
};

const SYSTEMS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

export function sharePayload(sum, { shareId, version, platform = process.platform }) {
  return {
    shareId,
    version,
    system: SYSTEMS[platform] ?? 'other',
    days: sum.days,
    washes: sum.washes,
    prompts: sum.prompts,
    notResent: sum.notResent,
    briefCost: sum.briefCost,
  };
}

const LABELS = {
  shareId: 'Share id',
  version: 'Carwash version',
  system: 'Operating system',
  days: 'Days since first brief',
  washes: 'Briefs written',
  prompts: 'Prompts in fresh sessions',
  notResent: 'Context not re-sent',
  briefCost: 'Spent writing briefs',
};

// Everything that would be sent, shown in full before asking.
export function describeShare(payload) {
  return [
    'This is everything that would be sent, to a Google Form the Carwash author reads:',
    '',
    ...Object.entries(payload).map(([key, value]) => `  ${LABELS[key].padEnd(28)}${value}`),
    '',
    'The share id is a random number made on this machine for sharing only, so sharing again replaces your last share instead of counting twice.',
    'No names, folders, projects, prompts, briefs or account details are included. You are not signed in to send it, and Google Forms does not show the author your IP address.',
  ].join('\n');
}

// The random id for shares, made on first use.
export function shareId(env) {
  try {
    const id = readFileSync(shareIdPath(env), 'utf8').trim();
    if (/^[0-9a-f]{12}$/.test(id)) return id;
  } catch {
    // not made yet
  }
  const id = randomBytes(6).toString('hex');
  writeFileAtomic(shareIdPath(env), `${id}\n`, 0o600);
  return id;
}

export const shareReady = (form = FORM) => Boolean(form.action) && Object.values(form.fields).every(Boolean);

// Send a share. Returns true once the form has accepted it.
export async function sendShare(payload, { form = FORM, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) body.set(form.fields[key], String(value));
  try {
    const response = await fetchImpl(form.action, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
