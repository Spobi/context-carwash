import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { privateDir, writeFileAtomic } from '../files.mjs';
import { recallDir, recallFile } from '../paths.mjs';
import { resultText } from '../stats/ledger.mjs';
import { toolInfo } from '../tools.mjs';

// A brief is a summary, so it leaves things out: the exact error, the path, the
// one number that matters. When a brief is saved, the session it came from is
// copied here as plain text, and the fresh session is told where to find it, so
// it can search for an exact detail instead of guessing.
//
// The session files themselves are poor to search. Theirs can run to hundreds
// of megabytes and one line of an image can be a megabyte or more, which a single
// search hit would pull into the conversation. This keeps only the words, ends
// at the wash so the brief is not in it twice, and wraps long lines. One file per
// brief, deleted after RECALL_DAYS or when the brief is discarded.

// Longest line kept whole, so one search hit stays a small one.
const WRAP = 2000;
const LONG_LINE = new RegExp(`.{1,${WRAP}}`, 'gsu');

// Past this, the oldest part of the session is left out. Real sessions are far
// smaller once images are gone: a few megabytes at the very most.
const MAX_BYTES = 16 * 1024 * 1024;

const CHUNK = 1024 * 1024;

// The lines of a file, without holding the whole of it in memory at once.
function* linesOf(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (!read) break;
      const lines = (rest + decoder.write(buffer.subarray(0, read))).split('\n');
      rest = lines.pop();
      yield* lines;
    }
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

// One transcript line as [who, text] pairs. Images, and anything else that is
// not words, come out empty and are dropped.
function claudeEntries(line) {
  if ((line.type !== 'user' && line.type !== 'assistant') || line.isMeta || line.isSidechain) return [];
  const content = line.message?.content;
  if (typeof content === 'string') return [[line.type, content]];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === 'text') return [[line.type, block.text]];
    if (block?.type === 'thinking') return [['assistant thinking', block.thinking]];
    if (block?.type === 'tool_use') return [[`tool call ${block.name}`, JSON.stringify(block.input)]];
    if (block?.type === 'tool_result') return [[block.is_error ? 'tool result (error)' : 'tool result', resultText(block)]];
    return [];
  });
}

const partsText = (parts) => (Array.isArray(parts) ? parts.map((part) => part?.text ?? '').join('') : '');

// The same for a Codex rollout line. Codex says the format is not a stable
// interface, so anything unexpected is simply left out.
function codexEntries(line) {
  if (line.type !== 'response_item') return [];
  const item = line.payload;
  switch (item?.type) {
    case 'message':
      return item.role === 'user' || item.role === 'assistant' ? [[item.role, partsText(item.content)]] : [];
    case 'reasoning':
      return [['assistant thinking', partsText(item.summary)]];
    case 'function_call':
      return [[`tool call ${item.name}`, item.arguments]];
    case 'custom_tool_call':
      return [[`tool call ${item.name}`, item.input]];
    case 'function_call_output':
    case 'custom_tool_call_output':
      return [['tool result', typeof item.output === 'string' ? item.output : partsText(item.output)]];
    default:
      return [];
  }
}

const READERS = {
  claude: { entries: claudeEntries, isWash: (text) => text.includes('<command-name>/wash</command-name>') || /^\s*\/wash(?![\w-])/.test(text) },
  codex: { entries: codexEntries, isWash: (text) => /^\s*\$wash(?![\w-])/.test(text) },
};

// Everything said in a session, up to the last wash.
function readEntries(file, tool) {
  const { entries: toEntries, isWash } = READERS[tool] ?? READERS.claude;
  const entries = [];
  let end = null;
  for (const raw of linesOf(file)) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || typeof line !== 'object') continue;
    for (const [who, text] of toEntries(line)) {
      if (typeof text !== 'string' || !text.trim()) continue;
      if (who === 'user' && isWash(text)) end = entries.length;
      entries.push({ who, time: line.timestamp, text });
    }
  }
  return end === null ? entries : entries.slice(0, end);
}

const wrapped = (text) => text.split('\n').map((line) => (line.length > WRAP ? line.match(LONG_LINE).join('\n') : line)).join('\n');

function render(entries, tool) {
  const kept = [];
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { who, time, text } = entries[i];
    const block = `--- #${i + 1} ${who}${time ? ` ${time}` : ''} ---\n${wrapped(text)}\n\n`;
    bytes += Buffer.byteLength(block);
    if (bytes > MAX_BYTES) break;
    kept.push(block);
  }
  const { name, wash } = toolInfo(tool);
  const dropped = entries.length - kept.length;
  const note = dropped ? ` The first ${dropped === 1 ? 'entry is' : `${dropped} entries are`} left out too, to keep this file small.` : '';
  return `A text copy of an earlier ${name} session, saved when ${wash} wrote its brief. Images are left out.${note}\nEach entry starts with a "--- #n who time ---" line.\n\n${kept.reverse().join('')}`;
}

// Copy a session to the file for brief `id`. Returns that file, or null if
// there was nothing to copy. The brief works without it, so a caller should not
// let a failure here stop anything.
export function saveRecall(env, id, transcript, tool = 'claude') {
  if (typeof transcript !== 'string' || !existsSync(transcript)) return null;
  const entries = readEntries(transcript, tool);
  if (!entries.length) return null;
  privateDir(recallDir(env));
  const file = recallFile(env, id);
  writeFileAtomic(file, render(entries, tool), 0o600);
  return file;
}

// The copy for brief `id`, or null if it is gone.
export function keptRecall(env, id) {
  const file = recallFile(env, id);
  return existsSync(file) ? file : null;
}
