#!/usr/bin/env node
// M1 spike helper. Records every hook invocation as one NDJSON line, then
// optionally replies with a canned response so we can observe Claude Code's
// behaviour.
//
// Usage (as a hook command): node log-hook.mjs <log.ndjson> [behavior.json]
//
// behavior.json maps "Event" or "Event:qualifier" (qualifier is the payload's
// source or reason) to { stdout?: object|string, stderr?: string, exit?: number,
// signalParent?: string, detachMs?: number, delayMs?: number,
// writeFile?: { path, content }, onlyIfEnv?: string, unlessEnv?: string }.
// "@lines:N" inside any string value expands to N characters of numbered lines
// ending in a sentinel, for testing the hook output cap. "${NAME}" expands to
// that environment variable.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [logPath, behaviorPath] = process.argv.slice(2);

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
  JSON.stringify({
    t: Date.now(),
    event: payload.hook_event_name,
    pid: process.pid,
    ppid: process.ppid,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env,
    payload,
  }) + '\n',
);

function numberedLines(chars) {
  const sentinel = `FINAL-SENTINEL-${chars}`;
  let out = '';
  for (let i = 1; out.length < chars - sentinel.length - 1; i++) {
    out += `LINE ${String(i).padStart(4, '0')} carwash brief filler text for cap testing.\n`;
  }
  return out.slice(0, chars - sentinel.length - 1) + '\n' + sentinel;
}

function expand(value) {
  if (typeof value === 'string') {
    return value
      .replace(/@lines:(\d+)/g, (_, n) => numberedLines(Number(n)))
      .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

if (behaviorPath && existsSync(behaviorPath)) {
  const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8'));
  const qualifier = payload.source ?? payload.reason ?? payload.command_name ?? '';
  const rule = behavior[`${payload.hook_event_name}:${qualifier}`] ?? behavior[payload.hook_event_name];
  const skipped =
    !rule || (rule.onlyIfEnv && !process.env[rule.onlyIfEnv]) || (rule.unlessEnv && process.env[rule.unlessEnv]);
  if (!skipped) {
    if (rule.writeFile) {
      const { path, content } = expand(rule.writeFile);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
    if (rule.stderr) process.stderr.write(expand(rule.stderr));
    if (rule.stdout !== undefined) {
      const out = expand(rule.stdout);
      process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
    }
    if (rule.signalParent && rule.detachMs) {
      // Signal Claude Code after this hook has returned, from a process that outlives it.
      spawn(
        process.execPath,
        ['-e', `setTimeout(() => process.kill(${process.ppid}, '${rule.signalParent}'), ${rule.detachMs})`],
        { detached: true, stdio: 'ignore' },
      ).unref();
    } else if (rule.signalParent) {
      process.kill(process.ppid, rule.signalParent);
    }
    process.exitCode = rule.exit ?? 0;
  }
}
