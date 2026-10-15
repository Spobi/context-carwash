import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDir, writeFileAtomic } from '../files.mjs';
import { codexConfigPath, codexHome, codexHooksPath, codexSkillDir } from '../paths.mjs';
import { UserError, readSettings, resolveSettingsFile, serializeSettings, sha256 } from './settings.mjs';
import { commandFor, withoutCarwashHooks } from './install.mjs';

// Carwash in Codex: three hooks in Codex's hooks file (~/.codex/hooks.json)
// and the $wash skill in ~/.codex/skills/wash. Codex's own config.toml is
// never written. Codex asks the person to trust new hooks before it runs them,
// and keeps that answer in config.toml; Carwash only reads it, for doctor.
//
// The hooks file has the same shape as Claude Code's `hooks` setting, so it is
// added to and taken out of the same way, and put back byte-for-byte when it
// has not changed since install.

const SKILL_SOURCE = fileURLToPath(new URL('../skill/codex', import.meta.url));
const SKILL_FILES = ['SKILL.md', join('agents', 'openai.yaml')];
const SKILL_MARK = 'installed-by: context-carwash';

// What each hook is narrowed to. Codex ignores matchers on UserPromptSubmit
// and Stop, so those run for every prompt and every reply, and return at once
// when there is no $wash. SessionStart passes the brief through whole: by
// default Codex saves context over 2,500 tokens to a file and shows the model
// only the start and end. The status message is the name Codex shows when it
// asks the person to trust the hooks, and beside one that runs slowly.
export const CODEX_HOOKS = {
  SessionStart: { group: { matcher: 'startup|clear' }, handler: { additionalContextLimit: 0 } },
  UserPromptSubmit: { group: {}, handler: {} },
  Stop: { group: {}, handler: {} },
};
const HOOK_TIMEOUT_SECONDS = 20;
const HOOK_NAME = 'Context Carwash';

export const isCarwashCodexHook = (command) => typeof command === 'string' && /carwash\.mjs['"]?\s+hook\s+codex\s*$/.test(command);

const tilde = (path) => (path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Whether Codex is set up on this machine: it makes its home folder the first
// time it runs.
export const codexDetected = (env = process.env) => existsSync(codexHome(env));

function withCarwashCodexHooks(hooks, command, file) {
  const refuse = () => {
    throw new UserError(`${tilde(file)} has a "hooks" setting that Carwash does not know how to add to. Nothing was changed.`);
  };
  if (hooks !== undefined && !isPlainObject(hooks)) refuse();
  const next = { ...(withoutCarwashHooks(hooks, isCarwashCodexHook) ?? {}) };
  for (const [event, { group, handler }] of Object.entries(CODEX_HOOKS)) {
    if (next[event] !== undefined && !Array.isArray(next[event])) refuse();
    next[event] = [...(next[event] ?? []), { ...group, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS, statusMessage: HOOK_NAME, ...handler }] }];
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

// Hooks written straight into config.toml, which Codex also reads. Approvals
// live under [hooks.state] and do not count.
function inlineHooks(env) {
  try {
    return /^\s*\[\[?\s*hooks\.(?!state\b)/m.test(readFileSync(codexConfigPath(env), 'utf8'));
  } catch {
    return false;
  }
}

// Work out what installing in Codex would change, without changing anything.
// `script` is where the installed copy of Carwash will be; `previous` is what
// an earlier install recorded about Codex, if anything.
export function planCodexInstall({ env = process.env, script, previous = null }) {
  const file = resolveSettingsFile(codexHooksPath(env));
  const settings = readSettings(file);
  const next = { ...settings.data, hooks: withCarwashCodexHooks(settings.data.hooks, commandFor('hook codex', script), file) };
  const dir = codexSkillDir(env);
  const skillFile = join(dir, 'SKILL.md');
  if (existsSync(skillFile) && !isOurSkill(skillFile)) {
    throw new UserError(`You already have a Codex skill called wash at ${tilde(dir)}, and Carwash needs that name. Nothing was changed. Rename or remove yours, then run install again.`);
  }
  const theirHooks = withoutCarwashHooks(settings.data.hooks, isCarwashCodexHook);
  return {
    file,
    settings,
    next,
    previous,
    skill: { dir, file: skillFile },
    keepsHooks: isPlainObject(theirHooks) && Object.keys(theirHooks).length > 0,
    inlineHooks: inlineHooks(env),
  };
}

// The install steps for Codex, numbered from `first`. `home` is Carwash's own
// folder, where a backup goes.
export function describeCodexInstall(plan, first, home) {
  const lines = [];
  lines.push(`  ${first}. Codex: ${plan.settings.exists ? 'edit' : 'create'} ${tilde(plan.file)}`);
  lines.push('       Adds three hooks, so $wash can save a brief and a fresh session can pick it up.');
  if (plan.keepsHooks) lines.push('       The hooks you already have there are kept as they are.');
  lines.push('       Codex asks you to trust new hooks before it runs them: the next time it');
  lines.push('       starts, choose "Trust all and continue".');
  if (plan.inlineHooks) lines.push('       You also have hooks in config.toml, so Codex will note hooks in two places. Both keep working.');
  if (plan.settings.exists && !plan.previous) lines.push(`       A backup of the file is kept in ${tilde(join(home, 'backup'))}`);
  lines.push(`  ${first + 1}. Codex: add the $wash command at ${tilde(plan.skill.dir)}`);
  return lines;
}

export function applyCodexInstall(plan, home) {
  const { file, settings, previous, skill } = plan;
  for (const name of SKILL_FILES) {
    mkdirSync(dirname(join(skill.dir, name)), { recursive: true });
    copyFileSync(join(SKILL_SOURCE, name), join(skill.dir, name));
  }

  // The first install records what was there; later runs must not overwrite it.
  let backupPath = previous?.backupPath ?? null;
  if (!previous && settings.exists) {
    privateDir(join(home, 'backup'));
    backupPath = join(home, 'backup', 'codex-hooks.json');
    writeFileSync(backupPath, settings.bytes, { mode: 0o600 });
  }

  const bytes = serializeSettings(plan.next, settings);
  writeFileAtomic(file, bytes, settings.exists ? undefined : 0o600);
  const pristine = !previous || (settings.exists && previous.installedSha256 === sha256(settings.bytes));
  return {
    hooksPath: file,
    hadHooksFile: previous ? previous.hadHooksFile : settings.exists,
    backupPath,
    originalSha256: previous ? previous.originalSha256 : settings.exists ? sha256(settings.bytes) : null,
    installedSha256: pristine ? sha256(bytes) : null,
    skillDir: skill.dir,
  };
}

// Work out what uninstalling from Codex would change. `record` is what install
// noted about Codex, or null (no record, or an install from before Codex
// support): then only Carwash's own entries are looked for and taken out.
export function planCodexUninstall({ env = process.env, record = null }) {
  const file = resolveSettingsFile(record?.hooksPath ?? codexHooksPath(env));
  const plan = { file, action: 'none', bytes: null };
  if (existsSync(file)) {
    const current = readFileSync(file);
    const backupOk = record?.backupPath && existsSync(record.backupPath) && sha256(readFileSync(record.backupPath)) === record.originalSha256;
    if (record && sha256(current) === record.installedSha256 && !record.hadHooksFile) {
      plan.action = 'delete';
    } else if (record && sha256(current) === record.installedSha256 && backupOk) {
      plan.action = 'restore';
      plan.bytes = readFileSync(record.backupPath);
    } else {
      // The file changed after install: undo only our own entries and keep the rest.
      const settings = readSettings(file);
      const hooks = withoutCarwashHooks(settings.data.hooks, isCarwashCodexHook);
      if (hooks !== settings.data.hooks) {
        const data = { ...settings.data };
        if (hooks === undefined) delete data.hooks;
        else data.hooks = hooks;
        if (!Object.keys(data).length && record && !record.hadHooksFile) {
          plan.action = 'delete';
        } else {
          plan.action = 'edit';
          plan.bytes = serializeSettings(data, settings);
        }
      }
    }
  }
  const dir = record?.skillDir ?? codexSkillDir(env);
  plan.skillDir = dir;
  plan.skill = isOurSkill(join(dir, 'SKILL.md'));
  plan.foreignSkill = !plan.skill && existsSync(join(dir, 'SKILL.md'));
  plan.found = plan.action !== 'none' || plan.skill;
  return plan;
}

export function describeCodexUninstall(plan) {
  const steps = [];
  const what = {
    restore: `Codex: restore ${tilde(plan.file)} to exactly what it was before install`,
    delete: `Codex: delete ${tilde(plan.file)} (Carwash created it and it has not changed since)`,
    edit: `Codex: edit ${tilde(plan.file)}: take out Carwash's hooks; everything else stays`,
  }[plan.action];
  if (what) steps.push([what]);
  if (plan.skill) steps.push([`Codex: remove the $wash command at ${tilde(plan.skillDir)}`]);
  else if (plan.foreignSkill && plan.action !== 'none') steps.push([`Codex: leave the wash skill at ${tilde(plan.skillDir)} alone (not Carwash's)`]);
  return steps;
}

export function applyCodexUninstall(plan) {
  if (plan.action === 'restore' || plan.action === 'edit') writeFileAtomic(plan.file, plan.bytes);
  if (plan.action === 'delete') unlinkSync(plan.file);
  if (plan.skill) {
    for (const name of SKILL_FILES) {
      try {
        unlinkSync(join(plan.skillDir, name));
      } catch {
        // already gone
      }
    }
    for (const dir of [join(plan.skillDir, 'agents'), plan.skillDir]) {
      try {
        rmdirSync(dir);
      } catch {
        // the folder holds something else, which stays
      }
    }
  }
}

// For doctor: which of Carwash's Codex hooks are in the hooks file, and which
// of those Codex has been told to trust. Codex keys each approval by the file,
// the event, and the hook's place in the file.
export function codexHooksCheck(env = process.env) {
  const file = resolveSettingsFile(codexHooksPath(env));
  let data;
  try {
    data = readSettings(file).data;
  } catch {
    return { readable: false, file };
  }
  let config = '';
  try {
    config = readFileSync(codexConfigPath(env), 'utf8');
  } catch {
    // no approvals yet
  }
  const snake = (event) => event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  // Codex may name the file as configured or with links resolved, and TOML
  // doubles the backslashes in a Windows path.
  const names = [...new Set([codexHooksPath(env), file])].flatMap((name) => [name, name.replace(/\\/g, '\\\\')]);
  const keyed = (key) => names.some((name) => config.includes(`[hooks.state."${name}${key}"]`));
  const result = { readable: true, file, hooks: {}, trusted: {}, nodes: [] };
  for (const event of Object.keys(CODEX_HOOKS)) {
    const groups = Array.isArray(data?.hooks?.[event]) ? data.hooks[event] : [];
    result.hooks[event] = false;
    result.trusted[event] = false;
    groups.forEach((group, g) => {
      (Array.isArray(group?.hooks) ? group.hooks : []).forEach((hook, h) => {
        if (!isCarwashCodexHook(hook?.command)) return;
        result.hooks[event] = true;
        result.nodes.push(hook.command);
        if (keyed(`:${snake(event)}:${g}:${h}`)) result.trusted[event] = true;
      });
    });
  }
  return result;
}

export const codexSkillInstalled = (env = process.env) => isOurSkill(join(codexSkillDir(env), 'SKILL.md'));
