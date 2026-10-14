import { LEVELS } from '../levels.mjs';
import { colorAt, colorDepth, paint } from './color.mjs';
import { availableColumns, clickModifier, supportsLinks, visibleWidth } from './terminal.mjs';

const BAR_CELLS = 15;
const GAP = '  ';

// From this share of the window on, the meter puts the colour into words.
// Like the colour, it is display only: nothing is triggered by it.
const FULL_AT = 75;
const FULL = 'getting full';

// What /wash does, said plainly. The levels and their caps are left to the
// command menu and /wash help, which show them when someone is choosing. The
// full form needs a wide window, the long one fits about half a Mac screen, and
// the middle one keeps the /clear step in an 80-column window, the Terminal.app
// default.
const HINT_FULL = '/wash to compress & save context, then /clear keeps compressed context';
const HINT_LONG = '/wash to compress & save context, then /clear';
const HINT_MID = '/wash to compress, then /clear';
const HINT_SHORT = '/wash to compress';

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// 850 -> "850", 1360 -> "1.4k", 136000 -> "136k", 1000000 -> "1M"
export function formatTokens(n) {
  const trim = (s) => s.replace(/\.0$/, '');
  if (n < 999.5) return String(Math.round(n));
  if (n < 99_950) return `${trim((n / 1000).toFixed(1))}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${trim((n / 1_000_000).toFixed(1))}M`;
}

// Pull what the meter needs from Claude Code's status line payload. Any field
// may be missing or null (they are null until the first response), so every
// value here is either a usable number or null.
export function readUsage(payload) {
  const cw = payload && typeof payload === 'object' ? (payload.context_window ?? {}) : {};
  const size = finite(cw.context_window_size) > 0 ? cw.context_window_size : null;

  // Same input-only sum Claude Code uses for used_percentage.
  let used = null;
  const usage = cw.current_usage;
  if (usage && typeof usage === 'object') {
    const sum =
      (finite(usage.input_tokens) ?? 0) +
      (finite(usage.cache_creation_input_tokens) ?? 0) +
      (finite(usage.cache_read_input_tokens) ?? 0);
    if (sum > 0) used = sum;
  }

  let pct = finite(cw.used_percentage);
  if (pct === null && used !== null && size) pct = (used / size) * 100;
  if (used === null && pct !== null && pct > 0 && size) used = Math.round((pct / 100) * size);
  if (pct !== null) pct = Math.min(100, Math.max(0, pct));
  return { pct, used, size };
}

// Estimated brief cap per level, formatted, or null when usage is unknown.
export function capLabels(used) {
  if (!used) return null;
  return Object.fromEntries(LEVELS.map((l) => [l.name, formatTokens(used * l.share)]));
}

function bar(pct, depth, style) {
  const filled = pct === null ? 0 : Math.min(BAR_CELLS, Math.max(0, Math.round((pct / 100) * BAR_CELLS)));
  let cells = '';
  for (let i = 0; i < filled; i++) {
    // 'ramp' colours each cell by its own position; 'solid' by the current reading.
    const at = style === 'solid' ? pct : ((i + 0.5) / BAR_CELLS) * 100;
    cells += paint('█', colorAt(at), depth);
  }
  return `[${cells}${'░'.repeat(BAR_CELLS - filled)}]`;
}

function linkedAction(caps, links, modifier) {
  const link = (url, text) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
  const names = LEVELS.map((l) => link(links[l.name], l.name) + (caps ? ` ≤${caps[l.name]}` : '')).join(' · ');
  return `Compress & New Session (${modifier}): ${names}`;
}

// Render Carwash's status line segment.
//
// options.columns   columns available (default: from COLUMNS in options.env)
// options.links     { light, mid, detailed } URLs; without them, or in a
//                   terminal that cannot click, the typed command is shown
// options.barStyle  'ramp' (default) or 'solid'
// options.state     { washing: level } while a brief is being written, or
//                   { ready: { level, tokens } } once one is waiting for /clear
//
// Returns { text, hasBar }: the richest candidate that fits. Narrow widths
// shorten the invitation in two steps, then lose the bar, and finally
// everything but the tokens in use and, once it applies, "getting full".
export function render(payload, options = {}) {
  const env = options.env ?? process.env;
  const columns = options.columns ?? availableColumns(env);
  const depth = colorDepth(env);
  const { pct, used } = readUsage(payload);

  // The reading is the tokens in use, and nothing else: a count is something
  // people can picture, and the bar already shows how much of the window that
  // is, so neither a percentage nor the window size is spelled out.
  const usedSeg = `session context ${used ? `~${formatTokens(used)}` : '--'}`;
  const barSeg = bar(pct, depth, options.barStyle ?? 'ramp');
  const caps = capLabels(used);
  // Only while inviting a wash: once one is under way there is nothing to add.
  const full = !options.state?.ready && !options.state?.washing && pct !== null && pct >= FULL_AT;
  const say = (invitation) => (full ? `${FULL} · ${invitation}` : invitation);

  let candidates;
  if (options.state?.ready) {
    // A brief is waiting: say so in place of the invitation to make one.
    const { level, tokens } = options.state.ready;
    const ready = `Brief ready ✓ ${level} ~${formatTokens(tokens)} · type /clear to start fresh with it`;
    candidates = [
      [usedSeg, barSeg, `${ready}. Old session stays in /resume.`],
      [usedSeg, barSeg, ready],
      [usedSeg, barSeg, 'Brief ready ✓ · /clear to start fresh'],
      [usedSeg, 'Brief ready ✓ · /clear to start fresh'],
      [usedSeg, 'Brief ready ✓'],
    ];
  } else if (options.state?.washing) {
    candidates = [
      [usedSeg, barSeg, 'washing…'],
      [usedSeg, 'washing…'],
    ];
  } else if (options.links && supportsLinks(env)) {
    const modifier = clickModifier(options.platform);
    candidates = [
      [usedSeg, barSeg, say(linkedAction(caps, options.links, modifier))],
      [usedSeg, barSeg, say(linkedAction(null, options.links, modifier))],
      [usedSeg, say(linkedAction(null, options.links, modifier))],
    ];
  } else {
    candidates = [
      [usedSeg, barSeg, say(HINT_FULL)],
      [usedSeg, barSeg, say(HINT_LONG)],
      [usedSeg, barSeg, say(HINT_MID)],
      [usedSeg, barSeg, say(HINT_SHORT)],
      [usedSeg, say(HINT_SHORT)],
    ];
  }
  if (full) candidates.push([usedSeg, FULL]);
  candidates.push([usedSeg]);

  for (const segments of candidates) {
    const text = segments.join(GAP);
    if (visibleWidth(text) <= columns) return { text, hasBar: segments.includes(barSeg) };
  }
  return { text: usedSeg, hasBar: false };
}
