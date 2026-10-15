// Plays the README demo: a long session, /wash, /clear, and a fresh session
// that picks up where the old one stopped. The meter is drawn by Carwash's own
// renderer; the conversation around it is scripted so the recording is the same
// every time. Recorded with VHS: `vhs docs/demo/demo.tape` from the repo root.

import { render } from '../../src/statusline/render.mjs';

const COLUMNS = 100;
const WINDOW = 200_000;
const env = { COLORTERM: 'truecolor', COLUMNS: String(COLUMNS) };

const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const accent = (s) => `\x1b[38;2;215;119;87m${s}\x1b[39m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { caption: '', lines: [], input: '', used: 0, meter: {} };

function meter() {
  const payload = { context_window: { context_window_size: WINDOW, used_percentage: (state.used / WINDOW) * 100 } };
  return render(payload, { env, state: state.meter }).text;
}

function draw() {
  const rule = dim('─'.repeat(COLUMNS));
  const out = [
    '',
    `  ${accent(state.caption)}`,
    '',
    ...state.lines.map((l) => `  ${l}`),
    '',
    rule,
    `${dim('>')} ${state.input}${state.cursor ? '▌' : ''}`,
    rule,
    `  ${meter()}`,
  ];
  process.stdout.write(`\x1b[H\x1b[2J${out.join('\n')}`);
}

async function type(text) {
  state.cursor = true;
  for (const ch of text) {
    state.input += ch;
    draw();
    await sleep(70);
  }
  await sleep(350);
  state.cursor = false;
}

async function submit() {
  state.lines.push(`${dim('>')} ${state.input}`);
  state.input = '';
  draw();
  await sleep(300);
}

async function grow(to, ms) {
  const from = state.used;
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    state.used = Math.round(from + ((to - from) * i) / steps);
    draw();
    await sleep(ms / steps);
  }
}

async function say(lines, gap = 120) {
  for (const l of lines) {
    state.lines.push(l);
    draw();
    await sleep(gap);
  }
}

process.stdout.write('\x1b[?25l');

// 1. Hours into a session, the meter fills up.
state.caption = 'Hour 3 of a long session';
state.used = 128_000;
state.lines = [
  `${accent('●')} Fixed the token refresh race in ${bold('src/auth/session.ts')}.`,
  `${accent('●')} Ran the auth tests: 2 of 3 pass. ${dim('refresh.test.ts › retries once')} still fails.`,
  `${accent('●')} Tried a mutex first, dropped it: it deadlocked on logout.`,
];
draw();
await sleep(600);
await grow(171_000, 1800);
await sleep(900);

// 2. /wash writes the brief.
state.caption = 'Wash it: Claude writes a short handoff brief';
await type('/wash');
await submit();
state.meter = { washing: 'mid' };
draw();
await sleep(700);
await say([
  '',
  `${accent('●')} ${bold('Carwash brief: Fix login token refresh')}`,
  `  ${dim('Objective')}  Stop users getting logged out when two tabs refresh at once.`,
  `  ${dim('State    ')}  Race fixed in session.ts. 2 of 3 tests pass. Mutex approach deadlocks: avoid.`,
  `  ${dim('Next     ')}  Make refresh.test.ts › retries once pass, then run the full suite.`,
], 260);
state.meter = { ready: { level: 'mid', tokens: 2100 } };
draw();
await sleep(2200);

// 3. /clear starts fresh with the brief.
state.caption = '/clear: a fresh session, with the brief already loaded';
await type('/clear');
state.input = '';
state.lines = [];
state.meter = {};
state.used = 19_000;
draw();
await sleep(1000);

await type('where were we?');
await submit();
await sleep(500);
await say([
  `${accent('●')} Fixing the login token refresh. The race in session.ts is fixed and 2 of 3`,
  `  tests pass. Next: ${bold('refresh.test.ts › retries once')}. I'll skip the mutex idea,`,
  '  since it deadlocked on logout. Want me to start on that test?',
], 200);
await sleep(1200);

state.caption = bold('Install: npx context-carwash install');
draw();
// Hold the last frame past the end of the recording.
await sleep(10_000);
process.stdout.write('\x1b[?25h');
