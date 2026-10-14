import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, homedir, release } from 'node:os';
import { join, sep } from 'node:path';
import { readJson } from '../files.mjs';
import { errorLogPath, errorsSeenPath, installRecordPath, settingsPath, skillDir } from '../paths.mjs';
import { refreshLedger, totals } from '../stats/ledger.mjs';
import { readyRecords } from '../wash/store.mjs';
import { isCarwashCommand, isCarwashHook } from './install.mjs';
import { UPDATE_COMMAND } from './notice.mjs';
import { readSettings, resolveSettingsFile } from './settings.mjs';
import { isNewer } from './update.mjs';

// `carwash doctor`: everything needed to tell what is wrong, in one block
// that can be pasted into an issue. It reads, and changes only one thing:
// the status line stops mentioning errors once they have been shown here.

export const ISSUES_URL = 'https://github.com/Spobi/context-carwash/issues/new';
const HOOK_EVENTS = ['SessionStart', 'Stop', 'UserPromptExpansion'];
const RECENT_ERRORS = 3;
const ERROR_LINES = 8;

const tilde = (text) => text.split(homedir() + sep).join(`~${sep}`);

// Claude Code's own version, or null if `claude` is not on PATH.
export function claudeVersion({ env = process.env, platform = process.platform } = {}) {
  try {
    const result = spawnSync('claude', ['--version'], { env, encoding: 'utf8', timeout: 5000, shell: platform === 'win32', windowsHide: true });
    const out = (result.stdout ?? '').trim();
    return result.status === 0 && out ? out.split('\n')[0] : null;
  } catch {
    return null;
  }
}

// The last few entries of the error log, newest last. Each entry starts with
// the time it was written; a stack trace follows on the next lines.
export function recentErrors(env = process.env) {
  let text;
  try {
    text = readFileSync(errorLogPath(env), 'utf8');
  } catch {
    return [];
  }
  const entries = text.split(/^(?=\d{4}-\d\d-\d\dT)/m).map((entry) => entry.trimEnd()).filter(Boolean);
  return entries.slice(-RECENT_ERRORS).map((entry) => {
    const lines = tilde(entry).split('\n');
    return lines.length > ERROR_LINES ? [...lines.slice(0, ERROR_LINES), '    …'].join('\n') : lines.join('\n');
  });
}

function settingsCheck(env) {
  const file = resolveSettingsFile(settingsPath(env));
  let data;
  try {
    data = readSettings(file).data;
  } catch {
    return { readable: false };
  }
  const groups = (event) => (Array.isArray(data?.hooks?.[event]) ? data.hooks[event] : []);
  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, groups(event).some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => isCarwashHook(hook?.command)))]));
  return { readable: true, statusLine: isCarwashCommand(data?.statusLine?.command), hooks };
}

const date = (iso) => {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) ? new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
};

// `running` is this copy's version, which under npx may differ from the copy
// installed in ~/.carwash/app. `newest` is what npm said just now: { latest,
// warning } or null.
export function doctorReport({ env = process.env, now = Date.now(), running, newest, claude, platform = process.platform }) {
  const row = (label, value) => `  ${label.padEnd(18)}${value}`;
  const record = readJson(installRecordPath(env));
  const installed = typeof record?.version === 'string' ? record.version : null;
  const out = ['Context Carwash doctor', ''];

  if (installed) {
    const when = date(record.installedAt);
    out.push(row('Installed', `${installed}${when ? ` (first installed ${when})` : ''}`));
  } else {
    out.push(row('Installed', 'no (run: npx context-carwash install)'));
  }
  if (running && running !== installed) out.push(row('This copy', running));
  if (env.CARWASH_NO_UPDATE_CHECK) out.push(row('Newest on npm', 'not checked (CARWASH_NO_UPDATE_CHECK is set)'));
  else if (!newest) out.push(row('Newest on npm', 'could not check (offline?)'));
  else out.push(row('Newest on npm', `${newest.latest}${installed && isNewer(newest.latest, installed) ? ` · to update: ${UPDATE_COMMAND}` : ''}`));
  if (newest?.warning) out.push(row('Warning', newest.warning));

  out.push(row('Node', process.version));
  out.push(row('System', `${platform} ${release()} ${arch()}`));
  out.push(row('Claude Code', claude ?? 'not found on PATH'));

  if (installed) {
    const check = settingsCheck(env);
    const yes = (ok) => (ok ? 'ok' : 'MISSING');
    if (!check.readable) {
      out.push(row('Settings', `could not read ${tilde(settingsPath(env))}`));
    } else {
      out.push(row('Status line', yes(check.statusLine)));
      out.push(row('Hooks', HOOK_EVENTS.map((event) => `${event} ${yes(check.hooks[event])}`).join(' · ')));
    }
    out.push(row('/wash command', yes(existsSync(join(skillDir(env), 'SKILL.md')))));
    let waiting = '?';
    let written = '?';
    try {
      waiting = String(readyRecords(env, now).length);
    } catch {
      // unreadable store
    }
    try {
      written = String(totals(refreshLedger(env, { now })).washes);
    } catch {
      // unreadable ledger
    }
    out.push(row('Briefs waiting', waiting));
    out.push(row('Briefs written', written));
  }

  const errors = recentErrors(env);
  out.push('');
  if (!errors.length) out.push(`Errors: none logged.`);
  else out.push(`Last ${errors.length === 1 ? 'error' : `${errors.length} errors`} (from ${tilde(errorLogPath(env))}):`, '', ...errors.map((entry) => entry.replace(/^/gm, '  ')));
  out.push('', `Something wrong? Open an issue and paste everything above: ${ISSUES_URL}`);
  return out.join('\n');
}

// The status line has said "hit an error" until now; this was the look.
export function markErrorsSeen(env = process.env) {
  try {
    writeFileSync(errorsSeenPath(env), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // nowhere to note it
  }
}
