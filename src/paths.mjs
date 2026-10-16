import { homedir } from 'node:os';
import { join } from 'node:path';

// Carwash's private storage. Lives outside any project.
export function carwashHome(env = process.env) {
  return env.CARWASH_HOME || join(homedir(), '.carwash');
}

// Claude Code's own config directory, honouring its documented override.
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Codex's own home directory, honouring its documented override.
export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

export function settingsPath(env = process.env) {
  return join(claudeConfigDir(env), 'settings.json');
}

export function installRecordPath(env = process.env) {
  return join(carwashHome(env), 'install.json');
}

// Briefs waiting to be delivered, and delivered ones kept a while for recovery.
export const pendingDir = (env = process.env) => join(carwashHome(env), 'pending');
export const consumedDir = (env = process.env) => join(carwashHome(env), 'consumed');

// Small per-session notes: the last usage reading and a wash in progress.
export const sessionsDir = (env = process.env) => join(carwashHome(env), 'sessions');

// The savings ledger behind `carwash stats`: one file per brief written.
export const statsDir = (env = process.env) => join(carwashHome(env), 'stats');

// A random id made the first time someone shares their stats, so a repeat
// share can replace the earlier one. It is not derived from anything.
export const shareIdPath = (env = process.env) => join(carwashHome(env), 'share-id');

export const errorLogPath = (env = process.env) => join(carwashHome(env), 'errors.log');

// Touched when someone has looked at the errors (doctor) or just installed, so
// the status line only mentions errors logged after that.
export const errorsSeenPath = (env = process.env) => join(carwashHome(env), 'errors-seen');

// What the last daily check found on npm: the newest version and any warning
// the author put on this one.
export const noticePath = (env = process.env) => join(carwashHome(env), 'notice.json');

// Present once the first-run welcome has been shown. Each tool says hello once.
export const welcomedPath = (env = process.env, tool = 'claude') => join(carwashHome(env), tool === 'claude' ? 'welcomed' : `welcomed-${tool}`);

// Where the /wash command is installed.
export const skillDir = (env = process.env) => join(claudeConfigDir(env), 'skills', 'wash');
export const legacyCommandPath = (env = process.env) => join(claudeConfigDir(env), 'commands', 'wash.md');

// Where Carwash goes in Codex: its hooks file, the $wash skill, and the config
// file Codex keeps hook approvals in (read, never written).
export const codexHooksPath = (env = process.env) => join(codexHome(env), 'hooks.json');
export const codexSkillDir = (env = process.env) => join(codexHome(env), 'skills', 'wash');
export const codexConfigPath = (env = process.env) => join(codexHome(env), 'config.toml');

// What Carwash has learned about how far sessions usually go: a few numbers
// per transcript, so the transcripts need not be read again.
export const habitsPath = (env = process.env) => join(carwashHome(env), 'habits.json');
