import { colorAt, colorDepth, paint } from './color.mjs';
import { availableColumns, clickModifier, isAppleTerminal, supportsLinks, visibleWidth } from './terminal.mjs';

// Brief presets: each cap is a share of the context currently in use.
export const LEVELS = [
  { name: 'light', share: 0.01 },
  { name: 'mid', share: 0.03 },
  { name: 'detailed', share: 0.1 },
];

const BAR_CELLS = 15;
const GAP = '  ';

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

function typedHint(caps, apple) {
  const names = LEVELS.map((l) => (caps ? `${l.name} ≤${caps[l.name]}` : l.name)).join(' | ');
  return `${apple ? "Terminal.app can't click links. " : ''}Type /wash ${names}`;
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
//
// Returns { text, hasBar }: the richest candidate that fits. Narrow widths lose
// the brief caps first, then the used/total count, then the Terminal.app
// sentence, then the bar, and finally everything but the percentage.
export function render(payload, options = {}) {
  const env = options.env ?? process.env;
  const columns = options.columns ?? availableColumns(env);
  const depth = colorDepth(env);
  const { pct, used, size } = readUsage(payload);

  const pctSeg = `ctx ${pct === null ? '--' : `${Math.round(pct)}%`}`;
  const tokSeg = used && size ? `~${formatTokens(used)}/${formatTokens(size)}` : null;
  const barSeg = bar(pct, depth, options.barStyle ?? 'ramp');
  const caps = capLabels(used);

  let candidates;
  if (options.links && supportsLinks(env)) {
    const modifier = clickModifier(options.platform);
    candidates = [
      [pctSeg, tokSeg, barSeg, linkedAction(caps, options.links, modifier)],
      [pctSeg, tokSeg, barSeg, linkedAction(null, options.links, modifier)],
      [pctSeg, barSeg, linkedAction(null, options.links, modifier)],
      [pctSeg, linkedAction(null, options.links, modifier)],
    ];
  } else {
    const apple = isAppleTerminal(env);
    candidates = [
      [pctSeg, tokSeg, barSeg, typedHint(caps, apple)],
      [pctSeg, tokSeg, barSeg, typedHint(null, apple)],
      [pctSeg, barSeg, typedHint(null, apple)],
      // Once the Terminal.app sentence cannot fit, the count gets its room back.
      [pctSeg, tokSeg, barSeg, typedHint(null, false)],
      [pctSeg, barSeg, typedHint(null, false)],
      [pctSeg, typedHint(null, false)],
    ];
  }
  candidates.push([pctSeg]);

  for (const segments of candidates) {
    const text = segments.filter(Boolean).join(GAP);
    if (visibleWidth(text) <= columns) return { text, hasBar: segments.includes(barSeg) };
  }
  return { text: pctSeg, hasBar: false };
}
