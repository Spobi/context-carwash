import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

// An error whose message is meant for the user; shown without a stack trace.
export class UserError extends Error {}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Follow a symlinked settings file (dotfile managers) so a write lands on the
// real file instead of replacing the link.
export function resolveSettingsFile(path) {
  return existsSync(path) ? realpathSync(path) : path;
}

// Read a Claude Code settings file, remembering enough about its formatting to
// write it back in the same style.
export function readSettings(file) {
  if (!existsSync(file)) {
    return { exists: false, bytes: null, data: {}, indent: '  ', eol: '\n', bom: false, trailingNewline: true };
  }
  const bytes = readFileSync(file);
  const raw = bytes.toString('utf8');
  const bom = raw.startsWith('﻿');
  const text = bom ? raw.slice(1) : raw;
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new UserError(`${file} is not valid JSON (${error.message}). Nothing was changed.`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new UserError(`${file} does not contain a JSON object. Nothing was changed.`);
  }
  return {
    exists: true,
    bytes,
    data,
    indent: text.match(/^([ \t]+)"/m)?.[1] ?? '  ',
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    bom,
    trailingNewline: /\n$/.test(text),
  };
}

export function serializeSettings(data, format) {
  let text = JSON.stringify(data, null, format.indent);
  if (format.trailingNewline) text += '\n';
  if (format.eol !== '\n') text = text.replace(/\n/g, format.eol);
  return Buffer.from((format.bom ? '﻿' : '') + text, 'utf8');
}
