// What the terminal can do, judged from the environment the status line runs in.

export function isAppleTerminal(env = process.env) {
  return env.TERM_PROGRAM === 'Apple_Terminal';
}

// Whether OSC 8 links will be clickable. Claude Code strips them itself when it
// does not detect support, so a wrong "yes" here shows a click hint on text that
// cannot be clicked. When unsure, say no: the typed command always works.
export function supportsLinks(env = process.env) {
  if (env.FORCE_HYPERLINK && env.FORCE_HYPERLINK !== '0') return true;
  if (isAppleTerminal(env)) return false;
  // tmux and screen pass links through only when configured to.
  if (env.TMUX || env.STY || env.TERM_PROGRAM === 'tmux') return false;
  if (['iTerm.app', 'vscode', 'ghostty', 'WezTerm', 'WarpTerminal', 'Hyper', 'Tabby'].includes(env.TERM_PROGRAM)) {
    return true;
  }
  if (env.KITTY_WINDOW_ID || env.WT_SESSION || env.KONSOLE_VERSION) return true;
  if (/^(xterm-kitty|xterm-ghostty|alacritty|foot)/.test(env.TERM ?? '')) return true;
  if (Number(env.VTE_VERSION) >= 5000) return true;
  return false;
}

export function clickModifier(platform = process.platform) {
  return platform === 'darwin' ? '⌘-click' : 'Ctrl-click';
}

// Columns the status line may fill. Claude Code indents it by two and keeps a
// two-column right margin, truncating anything longer with an ellipsis.
export function availableColumns(env = process.env) {
  const columns = Number.parseInt(env.COLUMNS ?? '', 10);
  return Number.isFinite(columns) && columns > 0 ? Math.max(1, columns - 4) : Infinity;
}

const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

// Columns a string occupies once escape sequences are removed.
export function visibleWidth(text) {
  return Array.from(text.replace(ESCAPES, '')).length;
}
