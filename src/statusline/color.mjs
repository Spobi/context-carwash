// Meter colours. Display only: no colour or threshold triggers anything.

// Percent used -> colour. Values between anchors are interpolated.
const ANCHORS = [
  [0, [0x17, 0x6b, 0x42]],
  [45, [0xa9, 0xa9, 0x1d]],
  [60, [0xd9, 0x79, 0x26]],
  [75, [0xc4, 0x3d, 0x32]],
  [90, [0x74, 0x1a, 0x22]],
  [100, [0x74, 0x1a, 0x22]],
];

export function colorAt(pct) {
  const p = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
  for (let i = 1; i < ANCHORS.length; i++) {
    const [hi, hiRgb] = ANCHORS[i];
    if (p <= hi) {
      const [lo, loRgb] = ANCHORS[i - 1];
      const t = hi === lo ? 0 : (p - lo) / (hi - lo);
      return loRgb.map((c, k) => Math.round(c + (hiRgb[k] - c) * t));
    }
  }
  return ANCHORS[ANCHORS.length - 1][1];
}

// 'truecolor' | '256' | 'none'
export function colorDepth(env = process.env) {
  if (env.NO_COLOR || env.TERM === 'dumb') return 'none';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (['iTerm.app', 'vscode', 'ghostty', 'WezTerm'].includes(env.TERM_PROGRAM) || env.WT_SESSION) return 'truecolor';
  return '256';
}

// Nearest colour in the xterm 256-colour palette (6x6x6 cube or grey ramp).
export function rgbTo256([r, g, b]) {
  const steps = [0, 95, 135, 175, 215, 255];
  const nearest = (v) => steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cube = [steps[ri], steps[gi], steps[bi]];
  const greyIndex = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const grey = 8 + greyIndex * 10;
  const dist = (c) => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
  return dist([grey, grey, grey]) < dist(cube) ? 232 + greyIndex : 16 + 36 * ri + 6 * gi + bi;
}

// Wrap text in a foreground colour, restoring the default foreground after.
export function paint(text, rgb, depth) {
  if (depth === 'none' || !text) return text;
  const open = depth === 'truecolor' ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${rgbTo256(rgb)}m`;
  return `${open}${text}\x1b[39m`;
}
