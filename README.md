# Context Carwash

A small, local-first utility for Claude Code.

- **Meter:** a quiet estimate of the active context window in the status line.
- **Wash:** when you ask, writes a bounded handoff brief and starts a fresh session that begins with it.

Nothing happens automatically, and nothing leaves your machine.

**Status:** pre-release. The meter works today; `/wash` is not built yet, so the command the meter mentions does nothing so far. See [plan-3.md](plan-3.md) for the design.

## Try the meter

Requires Node 18 or later.

```sh
git clone https://github.com/Spobi/context-carwash.git
cd context-carwash
node bin/carwash.mjs preview     # sample meters in your terminal, nothing installed
node bin/carwash.mjs install     # lists what it will change, then asks
```

The installer copies itself to `~/.carwash/app` and sets `statusLine` in `~/.claude/settings.json`. If you already have a status line, yours keeps running and the meter is added after it.

```text
ctx 68%  ~136k/200k  [██████████░░░░░]  Type /wash light ≤1.4k | mid ≤4.1k | detailed ≤13.6k
```

The percentage and token counts are estimates reported by Claude Code. The numbers after each level are the most a brief of that size may take: 1%, 3%, and 10% of the context in use. Narrower windows show less: the caps go first, then the token count, then the bar.

## Uninstall

```sh
node ~/.carwash/app/bin/carwash.mjs uninstall
```

This puts `settings.json` back exactly as it was. If you have edited the file since installing, it undoes only the status line setting and keeps your edits. It then deletes `~/.carwash`.

## Platforms

Developed and tested on macOS. Automated tests also run on Linux and Windows; neither has been tried by hand yet.

## License

MIT
