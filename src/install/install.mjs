import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carwashHome, installRecordPath, settingsPath } from '../paths.mjs';
import { UserError, readSettings, resolveSettingsFile, serializeSettings, sha256, writeFileAtomic } from './settings.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_ENTRIES = ['bin', 'src', 'package.json', 'LICENSE'];

export const packageVersion = () => JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

// Show paths under the home directory as ~/... in messages.
const tilde = (path) => (path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path);

// A path to this Node binary that survives upgrades: prefer the entry on PATH
// (often a stable symlink) over the resolved, version-specific location.
export function stableNodePath(env = process.env) {
  let real;
  try {
    real = realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'node');
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // not in this directory
    }
  }
  return process.execPath;
}

const shQuote = (s) => (/^[A-Za-z0-9_/.:@%+,=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// The statusLine command written into settings. On Windows Claude Code runs it
// through Git Bash or PowerShell, so paths use forward slashes and `node` comes
// from PATH (a quoted program path is not runnable in PowerShell).
export function statusLineCommand({ nodePath, scriptPath, platform = process.platform }) {
  if (platform === 'win32') {
    const script = scriptPath.replace(/\\/g, '/');
    return `node ${/\s/.test(script) ? `"${script}"` : script} statusline`;
  }
  return `${shQuote(nodePath)} ${shQuote(scriptPath)} statusline`;
}

export const isCarwashCommand = (command) =>
  typeof command === 'string' && /carwash\.mjs['"]?\s+statusline\s*$/.test(command);

function readRecord(env) {
  try {
    return JSON.parse(readFileSync(installRecordPath(env), 'utf8'));
  } catch {
    return null;
  }
}

function copyTree(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

// Work out what installing would change, without changing anything.
export function planInstall({ env = process.env, platform = process.platform } = {}) {
  const home = carwashHome(env);
  const appDir = join(home, 'app');
  const file = resolveSettingsFile(settingsPath(env));
  const settings = readSettings(file);
  const record = readRecord(env);
  const current = settings.data.statusLine;

  let original = null;
  let alreadyInstalled = false;
  if (current !== undefined) {
    if (isCarwashCommand(current?.command)) {
      alreadyInstalled = true;
      original = record?.statusLine?.original ?? null;
    } else if (current && current.type === 'command' && typeof current.command === 'string') {
      original = current;
    } else {
      throw new UserError(
        `${tilde(file)} has a statusLine that Carwash does not know how to wrap. Nothing was changed.`,
      );
    }
  }

  const command = statusLineCommand({
    nodePath: stableNodePath(env),
    scriptPath: join(appDir, 'bin', 'carwash.mjs'),
    platform,
  });
  const next = { ...settings.data, statusLine: { ...(original ?? {}), type: 'command', command } };

  return { home, appDir, file, settings, record, original, alreadyInstalled, next };
}

export function describeInstall(plan) {
  const lines = ['Context Carwash will make these changes:', ''];
  lines.push(`  1. Copy its files to ${tilde(plan.appDir)}`);
  lines.push(`  2. ${plan.settings.exists ? 'Edit' : 'Create'} ${tilde(plan.file)}`);
  if (plan.alreadyInstalled) {
    lines.push('       The Carwash status line is already there; its command is refreshed.');
  } else if (plan.original) {
    lines.push('       Your status line keeps running. The context meter is added after it.');
    lines.push(`       Yours: ${plan.original.command}`);
  } else {
    lines.push('       Adds a status line showing the context meter. You have none today.');
    lines.push('       Claude Code hides some footer hints (such as "esc to interrupt")');
    lines.push('       whenever any custom status line is set.');
  }
  if (plan.settings.exists && !plan.record) {
    lines.push(`       A backup of the file is kept in ${tilde(join(plan.home, 'backup'))}`);
  }
  lines.push('', 'Nothing else is touched. To undo everything: carwash uninstall');
  return lines.join('\n');
}

export function applyInstall(plan) {
  const { home, appDir, file, settings, record } = plan;
  privateDir(home);

  // Self-contained copy, so the status line keeps working if the package that
  // ran the installer (an npx cache, a Node version's global folder) goes away.
  if (resolve(PACKAGE_ROOT) !== resolve(appDir)) {
    rmSync(appDir, { recursive: true, force: true });
    for (const entry of APP_ENTRIES) {
      const from = join(PACKAGE_ROOT, entry);
      if (existsSync(from)) copyTree(from, join(appDir, entry));
    }
  }

  // The first install records what was there; later runs must not overwrite it.
  let backupPath = record?.backupPath ?? null;
  if (!record && settings.exists) {
    privateDir(join(home, 'backup'));
    backupPath = join(home, 'backup', 'settings.json');
    writeFileSync(backupPath, settings.bytes, { mode: 0o600 });
  }

  const bytes = serializeSettings(plan.next, settings);
  writeFileAtomic(file, bytes);

  // Uninstall may restore the backup byte-for-byte only while the file holds
  // exactly what Carwash wrote. If the user edited it between installs, that
  // promise is off for good and uninstall edits the one key instead.
  const pristine = !record || (settings.exists && record.installedSha256 === sha256(settings.bytes));

  const nextRecord = {
    version: packageVersion(),
    installedAt: record?.installedAt ?? new Date().toISOString(),
    settingsPath: file,
    hadSettingsFile: record ? record.hadSettingsFile : settings.exists,
    backupPath,
    originalSha256: record ? record.originalSha256 : settings.exists ? sha256(settings.bytes) : null,
    installedSha256: pristine ? sha256(bytes) : null,
    statusLine: { original: plan.original },
  };
  writeFileSync(installRecordPath({ CARWASH_HOME: home }), JSON.stringify(nextRecord, null, 2) + '\n', { mode: 0o600 });
  return nextRecord;
}

// Work out what uninstalling would change, without changing anything.
export function planUninstall({ env = process.env } = {}) {
  const home = carwashHome(env);
  const record = readRecord(env);
  const file = resolveSettingsFile(record?.settingsPath ?? settingsPath(env));
  const plan = { home, file, record, action: 'none', note: null, bytes: null };

  if (existsSync(file)) {
    const current = readFileSync(file);
    const backupOk =
      record?.backupPath && existsSync(record.backupPath) && sha256(readFileSync(record.backupPath)) === record.originalSha256;

    if (record && sha256(current) === record.installedSha256 && !record.hadSettingsFile) {
      plan.action = 'delete';
    } else if (record && sha256(current) === record.installedSha256 && backupOk) {
      plan.action = 'restore';
      plan.bytes = readFileSync(record.backupPath);
    } else {
      // The file changed after install: undo only our own key and keep the rest.
      const settings = readSettings(file);
      if (isCarwashCommand(settings.data.statusLine?.command)) {
        const data = { ...settings.data };
        if (record?.statusLine?.original) data.statusLine = record.statusLine.original;
        else delete data.statusLine;
        plan.action = 'edit';
        plan.bytes = serializeSettings(data, settings);
      } else if (settings.data.statusLine !== undefined) {
        plan.note = 'Your status line was changed after install, so it is left as it is.';
      }
    }
  }

  // Only ever delete a directory that is recognisably ours, and never the
  // home directory or a filesystem root, whatever CARWASH_HOME says.
  const full = resolve(home);
  const looksOurs = existsSync(join(home, 'install.json')) || existsSync(join(home, 'app', 'bin', 'carwash.mjs'));
  plan.removeHome = looksOurs && full !== resolve(homedir()) && dirname(full) !== full;
  return plan;
}

export function describeUninstall(plan) {
  const lines = ['Context Carwash will undo its changes:', ''];
  const what = {
    restore: `Restore ${tilde(plan.file)} to exactly what it was before install`,
    delete: `Delete ${tilde(plan.file)} (Carwash created it and it has not changed since)`,
    edit: `Edit ${tilde(plan.file)}: put your status line setting back; your other changes stay`,
    none: `Leave ${tilde(plan.file)} alone`,
  }[plan.action];
  lines.push(`  1. ${what}`);
  if (plan.note) lines.push(`       ${plan.note}`);
  lines.push(`  2. ${plan.removeHome ? `Delete ${tilde(plan.home)}` : `Leave ${tilde(plan.home)} alone (not a Carwash folder)`}`);
  return lines.join('\n');
}

export function applyUninstall(plan) {
  if (plan.action === 'restore' || plan.action === 'edit') writeFileAtomic(plan.file, plan.bytes);
  if (plan.action === 'delete') unlinkSync(plan.file);
  if (plan.removeHome) rmSync(plan.home, { recursive: true, force: true });
}
