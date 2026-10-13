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

export const errorLogPath = (env = process.env) => join(carwashHome(env), 'errors.log');

// Where the /wash command is installed.
export const skillDir = (env = process.env) => join(claudeConfigDir(env), 'skills', 'wash');
export const legacyCommandPath = (env = process.env) => join(claudeConfigDir(env), 'commands', 'wash.md');
