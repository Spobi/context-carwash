# Context Carwash

A small, local-first utility for Claude Code.

- **Meter:** a quiet estimate of the active context window in the status line.
- **Wash:** when you ask, Claude writes a short handoff brief, and your next `/clear` starts a fresh session that begins with it.

Nothing happens automatically, and nothing leaves your machine. The one exception: the installer asks npm whether a newer version is out.

**Status:** pre-release. The meter and the typed `/wash` command work today. Clickable links in the status line and the one-step restart are not built yet. See [plan-3.md](plan-3.md) for the design.

## Install

Requires Node 18 or later.

```sh
npx context-carwash preview     # sample meters in your terminal, nothing installed
npx context-carwash install     # lists what it will change, then asks
```

To update later, run `npx context-carwash install` again. Waiting briefs are kept. If npx reruns an older copy it downloaded before, the installer notices that npm has a newer version and installs that one instead.

The installer copies itself to `~/.carwash/app` and makes three changes to Claude Code, all listed before you confirm:

- **Status line** in `~/.claude/settings.json`. If you already have one, yours keeps running and the meter is added after it.
- **Three hooks** in the same file, added after any hooks you already have. They are how `/wash` saves a brief and how a fresh session receives it.
- **The `/wash` command** at `~/.claude/skills/wash`.

Start a new Claude Code session afterwards. The first one explains the meter and `/wash` in a short note, shown once.

## The meter

```text
session context ~136k  [██████████░░░░░]  /wash to compress & save context, then /clear keeps compressed context
```

The number is how many tokens the conversation is using. It comes from Claude Code and is an estimate. The bar shows how close that is to the most the model's context window holds, and changes colour as it fills. From three quarters on, the meter also says so in words:

```text
session context ~150k  [███████████░░░░]  getting full · /wash to compress & save context, then /clear keeps compressed context
```

Narrower windows show less. The sentence shortens first: `/wash to compress & save context, then /clear` fits about half a Mac screen, `/wash to compress, then /clear` fits an 80-column window, and the narrowest windows show `/wash to compress`. Then the bar goes.

A full meter is information. It never triggers anything.

## Starting fresh with a brief

1. Type `/wash` (or `/wash light`, `/wash detailed`). Claude replies with a brief: what you are doing, where things stand, and what to do next. The status line changes to `Brief ready ✓`.
2. Type `/clear`. The new session starts with that brief already loaded, and says so: `Loaded your Carwash brief (mid ~1.1k, 2m ago), down from ~136k in the old session.`

Your old conversation is not deleted. It stays in `/resume`.

| Command | What it does |
|---|---|
| `/wash` | Write a `mid` brief |
| `/wash light` | Goal, current state, next step |
| `/wash mid` | Adds constraints, decisions, state detail, pitfalls |
| `/wash detailed` | Adds rationale, history, test results, risks, a step checklist |
| `/wash discard` | Drop the brief. `/clear` is a normal clear again |
| `/wash load [id]` | Make a waiting brief the one your next `/clear` uses |
| `/wash help` | Explain the meter and these options, with this session's size limits |

Each level has a size limit: the most tokens its brief may take, worked out from what the conversation is using (a hundredth for `light`, three hundredths for `mid`, a tenth for `detailed`). `/wash help` shows the limits for the session you are in.

Words after the level are passed to Claude as a note on what to emphasise: `/wash mid focus on the failing test`.

Things worth knowing:

- **A `/clear` with no brief ready is a normal clear.** Carwash only acts when you have asked for a brief in that terminal.
- **Writing a brief costs tokens.** It is an ordinary Claude reply. `help`, `discard` and `load` cost nothing: they never reach Claude.
- **The cap is a ceiling, not a target.** A brief is as short as it can be. If one comes out over its cap, Claude is asked to shorten it, up to twice. If it is still over, it is kept and the message says so.
- **Sizes are estimates.** The brief's size is worked out from its length. It covers the brief alone, so the meter in the new session reads higher: it also counts Claude Code's own baseline.
- **Closed the terminal before clearing?** Start `claude` in the same folder. If exactly one brief is waiting for that folder, it is under 12 hours old, and the session that wrote it has ended, it is loaded. If there is any doubt about which brief is meant, nothing is loaded and you are shown what is waiting, with the `/wash load <id>` to use.
- **Briefs expire after 48 hours.** A delivered brief is kept for 24 hours in case you want it again (`/wash load <id>`), then deleted.

## Where things are kept

Briefs are stored in `~/.carwash`, readable only by you, and never inside your project. Nothing is uploaded, and there is no telemetry. The installer reads the newest version number from npm, and nothing else goes online; set `CARWASH_NO_UPDATE_CHECK=1` to skip even that.

If a hook fails it stays silent and writes the error to `~/.carwash/errors.log`.

## Uninstall

```sh
npx context-carwash uninstall
```

This puts `settings.json` back exactly as it was. If you have edited the file since installing, it removes only Carwash's own status line and hooks and keeps your edits. It then removes the `/wash` command and deletes `~/.carwash`, including any briefs still waiting.

## Limitations

- Terminal.app cannot click links. When clickable links arrive for other terminals, Terminal.app will keep showing the command to type.
- The status line re-runs every 5 seconds while a session is open, so it stays correct after `/wash discard` and `/wash load`. Each run reads a few small local files. If your own status line sets a refresh interval, yours is kept.
- Claude Code shows `help`, `discard`, `load`, and mistyped arguments under the heading "operation blocked by hook". That is Carwash answering the command itself instead of sending it to Claude.

## Platforms

Developed and tested on macOS. Automated tests also run on Linux and Windows; neither has been tried by hand yet.

## License

MIT
