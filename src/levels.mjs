// Brief presets: each cap is a share of the context currently in use.
export const LEVELS = [
  { name: 'light', share: 0.01 },
  { name: 'mid', share: 0.03 },
  { name: 'detailed', share: 0.1 },
];

export const DEFAULT_LEVEL = 'mid';

export const isLevel = (name) => LEVELS.some((l) => l.name === name);

// The most tokens a brief at this level may take, or null when usage is unknown.
export function capFor(level, used) {
  const share = LEVELS.find((l) => l.name === level)?.share;
  return share && used ? Math.round(used * share) : null;
}

// There is no tokenizer here, so a brief's size is estimated from its length.
// The divisor leans low (more tokens per character) so the estimate errs
// towards over the cap, not under it.
export const CHARS_PER_TOKEN = 3.5;

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);
