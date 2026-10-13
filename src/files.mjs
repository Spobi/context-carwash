import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TEMP_SUFFIX = '.carwash-tmp';

// A directory only this user can enter.
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

// Replace a file's contents in one step, keeping its permissions.
export function writeFileAtomic(file, bytes, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const keepMode = mode ?? (existsSync(file) ? statSync(file).mode & 0o777 : 0o600);
  const temp = join(dirname(file), `.${process.pid}.${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`);
  writeFileSync(temp, bytes, { mode: keepMode });
  renameSync(temp, file);
}

// Parsed contents of a JSON file, or null if it is missing or unreadable.
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Write JSON into Carwash's own storage, readable by this user only.
export function writePrivateJson(file, data) {
  privateDir(dirname(file));
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o600);
}
