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
