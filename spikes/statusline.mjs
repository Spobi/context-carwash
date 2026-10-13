#!/usr/bin/env node
// M1 spike helper. Records the status line payload and environment, then prints
// a line exercising truecolor and an OSC 8 link so we can see what survives.
//
// Usage (as the statusLine command): node statusline.mjs <log.ndjson>
import { appendFileSync, readFileSync } from 'node:fs';

const [logPath] = process.argv.slice(2);

const raw = readFileSync(0, 'utf8');
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  payload = { unparsed: raw };
}

const env = Object.fromEntries(
  Object.keys(process.env)
    .filter((k) => /^(CLAUDE|CARWASH|TERM|COLUMNS|LINES|FORCE_HYPERLINK|COLORTERM)/.test(k))
    .sort()
    .map((k) => [k, /TOKEN|KEY|SECRET/.test(k) ? '<redacted>' : process.env[k]]),
);

appendFileSync(
  logPath,
  JSON.stringify({ t: Date.now(), event: 'statusLine', pid: process.pid, ppid: process.ppid, env, payload }) + '\n',
);

const pct = Math.round(payload.context_window?.used_percentage ?? 0);
const rgb = (r, g, b, s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const link = (url, text) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

process.stdout.write(
  `SPIKE ctx ${pct}% ${rgb(23, 107, 66, '███')}${rgb(217, 121, 38, '███')}${rgb(116, 26, 34, '███')} ` +
    `${link('http://127.0.0.1:9/spike', 'LINKTEXT')} cols=${process.env.COLUMNS ?? '?'}\n`,
);
