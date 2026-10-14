import { CHARS_PER_TOKEN, capFor } from '../levels.mjs';
import { formatTokens } from '../statusline/render.mjs';

// The wording around a brief: what Claude is told when writing one, how its
// reply is recognised, and what the user and the next session are shown. Also
// the two places Carwash explains itself: the first-run welcome and /wash help.

// Every brief opens with this heading. It is how a reply is known to be a
// brief, and where anything written before it is cut off.
const HEADING = /^[ \t]*#{1,6}[ \t]*Carwash brief[ \t]*[:—–-][ \t]*(.*)$/im;

const TITLE_LENGTH = 60;

// A one-line title that is safe to print in a terminal.
export function cleanTitle(raw) {
  const title = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[<"'[(]+|[>"'\])]+$/g, '');
  const chars = Array.from(title);
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH - 1).join('')}…` : title;
}

// Pull the brief out of Claude's reply to /wash: { text, title }, or null if
// the reply is not a brief.
export function parseReply(message) {
  if (typeof message !== 'string') return null;
  const found = HEADING.exec(message);
  if (!found) return null;
  let text = message.slice(found.index).trim();
  // A reply wrapped whole in a code fence leaves its closing fence behind.
  if ((text.match(/^[ \t]*```/gm) ?? []).length % 2 === 1) text = text.replace(/\n[ \t]*```+[ \t]*$/, '').trim();
  if (!text.slice(found[0].length).trim()) return null;
  return { text, title: cleanTitle(found[1]) || 'Untitled' };
}

export function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

const ageOf = (record, now) => formatAge(now - Date.parse(record.createdAt));
const sizeOf = (record) => `${record.level} ~${formatTokens(record.tokens)}`;

// a3f9c2 "Fix login redirect" (mid ~1.1k, 14h ago)
export const describe = (record, now) => `${record.id} "${record.title}" (${sizeOf(record)}, ${ageOf(record, now)})`;

// Sent to Claude alongside the /wash prompt: the size limit for this brief.
export function budgetNote(level, cap, used) {
  if (!cap) {
    return `Carwash: level ${level}. The size of this session is not known yet, so there is no token ceiling for this brief. Keep to the ${level} scope and keep it short.`;
  }
  const chars = Math.max(100, Math.round((cap * CHARS_PER_TOKEN) / 100) * 100);
  return (
    `Carwash: level ${level}. This session is using about ${formatTokens(used)} tokens, so the ceiling for this brief is ${cap} tokens, ` +
    `which is roughly ${chars} characters. That is a limit, not a target: stop as soon as the brief is complete.`
  );
}

// Sent to Claude when its brief came out over the cap.
export function retryNote(level, cap, tokens) {
  return (
    `Carwash: that brief is about ${tokens} tokens, over the ${cap}-token ceiling for ${level}. Send it again shortened to fit. ` +
    'Keep the "# Carwash brief:" heading and the Core section, cut the least useful detail first, and reply with the brief alone.'
  );
}

const NEXT_STEP = 'Type /clear to start fresh with it. This is not a normal clear: your brief carries over. Old session stays in /resume.';

// Shown to the user once a brief has been saved.
export function readyMessage(record) {
  let size = sizeOf(record);
  if (record.overCap) size += `, which is over the ${formatTokens(record.cap)} cap even after asking for a shorter one`;
  else if (record.cap) size += ` of ${formatTokens(record.cap)} cap`;
  return `Brief ready ✓ ${size}. ${NEXT_STEP}`;
}

// One line on how the repository differs from when the brief was written, or
// null if it has not moved (or there is no way to tell).
export function stalenessLine(source, current) {
  if (!source || !current) return null;
  if (source.worktree && current.worktree && source.worktree !== current.worktree) {
    return `This brief was written in a different folder: ${source.worktree}.`;
  }
  const short = (sha) => sha.slice(0, 7);
  const moved = [];
  if (source.head && current.head && source.head !== current.head) moved.push(`HEAD ${short(source.head)}→${short(current.head)}`);
  if (source.head && current.head && source.branch !== current.branch) {
    moved.push(`branch ${source.branch ?? 'detached'}→${current.branch ?? 'detached'}`);
  }
  if (source.dirty === true && current.dirty === false) moved.push('the uncommitted changes are gone');
  if (source.dirty === false && current.dirty === true) moved.push('there are new uncommitted changes');
  return moved.length ? `Repo changed since this brief: ${moved.join(', ')}.` : null;
}

// Shown to the user when a fresh session starts with a brief. The old
// session's size is the reading /wash was sized from, when there was one.
export function loadedMessage(record, now, stale) {
  const before = Number.isFinite(record.used) && record.used > 0 ? `, down from ~${formatTokens(record.used)} in the old session` : '';
  return (
    `Loaded your Carwash brief (${sizeOf(record)}, ${ageOf(record, now)})${before}.${stale ? ` ${stale}` : ''} ` +
    "That size is the brief alone; the meter also counts Claude Code's own baseline."
  );
}

// Shown once, at the first session after install.
export function welcomeMessage() {
  return [
    'Context Carwash installed ✓ (shown once)',
    '  • Status line: tokens in use, and how full the context is',
    '  • Getting full? /wash, then /clear. You start fresh, right where you left off',
    '  • Nothing runs on its own · /wash help for options',
  ].join('\n');
}

// What each level keeps, for /wash help.
const LEVEL_NOTES = {
  light: 'goal, where things stand, next step',
  mid: 'adds decisions, constraints, pitfalls (the default)',
  detailed: 'adds reasoning, history, test results, a checklist',
};

// /wash help. `used` is this session's reading, when known, so each level can
// show the most tokens its brief may take here.
export function helpMessage(used) {
  const row = (args, note) => `  /wash ${args.padEnd(16)}${note}`;
  const level = (name) => {
    const cap = capFor(name, used);
    return row(name, `${LEVEL_NOTES[name]}${cap ? `, up to ${formatTokens(cap)} tokens` : ''}`);
  };
  return [
    '/wash compresses this conversation into a short brief. Your next /clear then starts a fresh session that begins with it, and the old session stays in /resume.',
    '',
    level('light'),
    level('mid'),
    level('detailed'),
    row('discard', 'drop the brief; /clear is a normal clear again'),
    row('load [id]', 'make a waiting brief the one /clear uses'),
    '',
    "The status line shows how many tokens this conversation is using, and the bar shows how close that is to the model's limit.",
    'Writing a brief is an ordinary Claude reply, so it uses tokens. help, discard and load do not.',
  ].join('\n');
}

// Shown to the user when briefs are waiting but none was loaded.
export function pointerMessage(records, now, why) {
  const one = records.length === 1;
  const listed = records.slice(0, 3).map((record) => describe(record, now));
  if (records.length > 3) listed.push(`and ${records.length - 3} more`);
  return (
    `Carwash: ${one ? 'a brief is' : `${records.length} briefs are`} waiting for this folder. ` +
    `${one ? 'It was not' : 'None was'} loaded because ${why}. ${listed.join(' · ')}. ` +
    `To use ${one ? 'it' : 'one'}: /wash load ${one ? records[0].id : '<id>'}, then /clear.`
  );
}

// What the fresh session's model is given. The framing is kept short: when the
// whole thing is over Claude Code's limit for hook output, only the first 2,000
// characters arrive inline, and the brief's Core section has to be among them.
export function composeContext(record, now, stale) {
  return [
    '# Carwash handoff',
    '',
    `The user ran /wash in an earlier session and started this one to carry on from it. The brief below (${record.level}, written ${ageOf(record, now)}) is what that session handed over. The earlier conversation is not available to you.`,
    'If the brief is cut off below, or a note says the full text was saved to a file, read that file in full before you reply.',
    'Check the current state of a file before acting on what the brief says about it.',
    ...(stale ? [stale] : []),
    '',
    '---',
    '',
    record.brief,
  ].join('\n');
}
