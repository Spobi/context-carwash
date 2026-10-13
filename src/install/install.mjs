import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDir, readJson, writeFileAtomic } from '../files.mjs';
import { carwashHome, installRecordPath, legacyCommandPath, pendingDir, settingsPath, skillDir } from '../paths.mjs';
import { UserError, readSettings, resolveSettingsFile, serializeSettings, sha256 } from './settings.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_ENTRIES = ['bin', 'src', 'package.json', 'LICENSE'];
const SKILL_SOURCE = join(PACKAGE_ROOT, 'src', 'skill', 'SKILL.md');
// A line in our SKILL.md, so a /wash command that is not ours is never touched.
const SKILL_MARK = 'installed-by: context-carwash';

// The hooks /wash needs, and what each is narrowed to: only brand-new
// conversations, and only the /wash command. Stop cannot be narrowed.
const HOOKS = {
  SessionStart: { matcher: 'startup|clear' },
  Stop: {},
  UserPromptExpansion: { matcher: 'wash' },
};
const HOOK_TIMEOUT_SECONDS = 20;

// How often Claude Code re-runs the status line while a session sits idle.
// Without it the line only changes when Claude replies, so it would go on
// saying "Brief ready" after /wash discard. Each run is a local file read.
const REFRESH_SECONDS = 5;

export const packageVersion = () => JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

// Show paths under the home directory as ~/... in messages.
const tilde = (path) => (path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

// A command line that runs `carwash <verb>`, as written into settings. On
// Windows Claude Code runs it through Git Bash or PowerShell, so paths use
// forward slashes and `node` comes from PATH (a quoted program path is not
// runnable in PowerShell).
export function commandFor(verb, { nodePath, scriptPath, platform = process.platform }) {
  if (platform === 'win32') {
    const script = scriptPath.replace(/\\/g, '/');
    return `node ${/\s/.test(script) ? `"${script}"` : script} ${verb}`;
  }
  return `${shQuote(nodePath)} ${shQuote(scriptPath)} ${verb}`;
}

export const statusLineCommand = (options) => commandFor('statusline', options);

const runsCarwash = (verb) => (command) => typeof command === 'string' && new RegExp(`carwash\\.mjs['"]?\\s+${verb}\\s*$`).test(command);
export const isCarwashCommand = runsCarwash('statusline');
export const isCarwashHook = runsCarwash('hook');

// The `hooks` setting with Carwash's own entries taken out. An event's list,
// or the whole setting, goes too if it only existed to hold ours. Returns the
// same object when there was nothing of ours in it.
export function withoutCarwashHooks(hooks) {
  if (!isPlainObject(hooks)) return hooks;
  const next = {};
  let found = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = [];
    for (const group of groups) {
      const ours = Array.isArray(group?.hooks) && group.hooks.some((hook) => isCarwashHook(hook?.command));
      if (!ours) {
        kept.push(group);
        continue;
      }
      found = true;
      const theirs = group.hooks.filter((hook) => !isCarwashHook(hook?.command));
      if (theirs.length) kept.push({ ...group, hooks: theirs });
    }
    if (kept.length || kept.length === groups.length) next[event] = kept;
  }
  if (!found) return hooks;
  return Object.keys(next).length ? next : undefined;
}

// The `hooks` setting with Carwash's entries added after whatever is there.
function withCarwashHooks(hooks, command, file) {
  const refuse = () => {
    throw new UserError(`${tilde(file)} has a "hooks" setting that Carwash does not know how to add to. Nothing was changed.`);
  };
  if (hooks !== undefined && !isPlainObject(hooks)) refuse();
  const next = { ...(withoutCarwashHooks(hooks) ?? {}) };
  for (const [event, narrowing] of Object.entries(HOOKS)) {
    if (next[event] !== undefined && !Array.isArray(next[event])) refuse();
    next[event] = [...(next[event] ?? []), { ...narrowing, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  return next;
}

function isOurSkill(file) {
  try {
    return readFileSync(file, 'utf8').includes(SKILL_MARK);
  } catch {
    return false;
  }
}

// Where /wash goes. Refuses if the user already has a command by that name.
function planSkill(env) {
  const dir = skillDir(env);
  const file = join(dir, 'SKILL.md');
  const taken = (path) =>
    new UserError(`You already have a /wash command at ${tilde(path)}, and Carwash needs that name. Nothing was changed. Rename or remove yours, then run install again.`);
  if (existsSync(file) && !isOurSkill(file)) throw taken(dir);
  if (existsSync(legacyCommandPath(env))) throw taken(legacyCommandPath(env));
  return { dir, file };
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

// Work out what installing would change, without changing anything.
export function planInstall({ env = process.env, platform = process.platform } = {}) {
  const home = carwashHome(env);
  const appDir = join(home, 'app');
  const file = resolveSettingsFile(settingsPath(env));
  const settings = readSettings(file);
  const record = readJson(installRecordPath(env));
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

  const script = { nodePath: stableNodePath(env), scriptPath: join(appDir, 'bin', 'carwash.mjs'), platform };
  const theirHooks = withoutCarwashHooks(settings.data.hooks);
  const next = {
    ...settings.data,
    statusLine: { refreshInterval: REFRESH_SECONDS, ...(original ?? {}), type: 'command', command: commandFor('statusline', script) },
    hooks: withCarwashHooks(settings.data.hooks, commandFor('hook', script), file),
  };
  const skill = planSkill(env);

  return { home, appDir, file, settings, record, original, alreadyInstalled, next, skill, keepsHooks: isPlainObject(theirHooks) && Object.keys(theirHooks).length > 0 };
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
  lines.push('       Adds three hooks, so /wash can save a brief and a fresh session can');
  lines.push(`       pick it up.${plan.keepsHooks ? ' The hooks you already have are kept as they are.' : ''}`);
  if (plan.settings.exists && !plan.record) {
    lines.push(`       A backup of the file is kept in ${tilde(join(plan.home, 'backup'))}`);
  }
  lines.push(`  3. Add the /wash command at ${tilde(plan.skill.dir)}`);
  lines.push('', 'Writing a brief is an ordinary Claude reply, so it uses tokens like any other.');
  lines.push('Nothing else is touched. To undo everything: carwash uninstall');
  return lines.join('\n');
}

export function applyInstall(plan) {
  const { home, appDir, file, settings, record, skill } = plan;
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

  mkdirSync(skill.dir, { recursive: true });
  copyFileSync(SKILL_SOURCE, skill.file);

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
  // promise is off for good and uninstall edits our own keys instead.
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
    skillPath: skill.file,
  };
  writeFileSync(installRecordPath({ CARWASH_HOME: home }), JSON.stringify(nextRecord, null, 2) + '\n', { mode: 0o600 });
  return nextRecord;
}

function countBriefs(env) {
  try {
    return readdirSync(pendingDir(env)).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// Work out what uninstalling would change, without changing anything.
export function planUninstall({ env = process.env } = {}) {
  const home = carwashHome(env);
  const record = readJson(installRecordPath(env));
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
      // The file changed after install: undo only our own entries and keep the rest.
      const settings = readSettings(file);
      const data = { ...settings.data };
      let changed = false;
      if (isCarwashCommand(data.statusLine?.command)) {
        if (record?.statusLine?.original) data.statusLine = record.statusLine.original;
        else delete data.statusLine;
        changed = true;
      } else if (data.statusLine !== undefined) {
        plan.note = 'Your status line was changed after install, so it is left as it is.';
      }
      const hooks = withoutCarwashHooks(data.hooks);
      if (hooks !== data.hooks) {
        if (hooks === undefined) delete data.hooks;
        else data.hooks = hooks;
        changed = true;
      }
      if (changed) {
        plan.action = 'edit';
        plan.bytes = serializeSettings(data, settings);
      }
    }
  }

  // The /wash command: removed if it is ours, left alone if someone else's.
  const skillFile = record?.skillPath ?? join(skillDir(env), 'SKILL.md');
  plan.skillDir = dirname(skillFile);
  plan.skill = isOurSkill(skillFile) ? skillFile : null;
  plan.foreignSkill = !plan.skill && existsSync(skillFile);

  // Only ever delete a directory that is recognisably ours, and never the
  // home directory or a filesystem root, whatever CARWASH_HOME says.
  const full = resolve(home);
  const looksOurs = existsSync(join(home, 'install.json')) || existsSync(join(home, 'app', 'bin', 'carwash.mjs'));
  plan.removeHome = looksOurs && full !== resolve(homedir()) && dirname(full) !== full;
  plan.briefs = plan.removeHome ? countBriefs(env) : 0;
  return plan;
}

export function describeUninstall(plan) {
  const lines = ['Context Carwash will undo its changes:', ''];
  const what = {
    restore: `Restore ${tilde(plan.file)} to exactly what it was before install`,
    delete: `Delete ${tilde(plan.file)} (Carwash created it and it has not changed since)`,
    edit: `Edit ${tilde(plan.file)}: undo Carwash's status line and hooks; your other changes stay`,
    none: `Leave ${tilde(plan.file)} alone`,
  }[plan.action];
  const steps = [[what, plan.note]];
  if (plan.skill) steps.push([`Remove the /wash command at ${tilde(plan.skillDir)}`]);
  else if (plan.foreignSkill) steps.push([`Leave the /wash command at ${tilde(plan.skillDir)} alone (not Carwash's)`]);
  const briefs = plan.briefs ? `, including ${plan.briefs} waiting ${plan.briefs === 1 ? 'brief' : 'briefs'}` : '';
  steps.push([plan.removeHome ? `Delete ${tilde(plan.home)}${briefs}` : `Leave ${tilde(plan.home)} alone (not a Carwash folder)`]);
  steps.forEach(([step, note], i) => {
    lines.push(`  ${i + 1}. ${step}`);
    if (note) lines.push(`       ${note}`);
  });
  return lines.join('\n');
}

export function applyUninstall(plan) {
  if (plan.action === 'restore' || plan.action === 'edit') writeFileAtomic(plan.file, plan.bytes);
  if (plan.action === 'delete') unlinkSync(plan.file);
  if (plan.skill) {
    unlinkSync(plan.skill);
    try {
      rmdirSync(plan.skillDir);
    } catch {
      // the folder holds something else, which stays
    }
  }
  if (plan.removeHome) rmSync(plan.home, { recursive: true, force: true });
}
