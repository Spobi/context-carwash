# Context Carwash

Context Carwash adds a line to Claude Code in your terminal that:

1. Shows the current conversation's context size.
2. Lets you compress your context and start a new session without losing the important details.

## Install

Requires Node 18 or later.

```sh
npx context-carwash preview     # see sample meters, nothing installed
npx context-carwash install     # lists what it will change, then asks
```

Then start a new Claude Code session. To update later, run `npx context-carwash@latest install`. You don't need to watch for updates: a line under the meter tells you when there's a new version.

The installer adds a status line and three hooks to `~/.claude/settings.json`, after anything you already have there, and adds the `/wash` command at `~/.claude/skills/wash`.

## The meter

```text
session context ~136k  [██████████░░░░░]  /wash to compress & save context, then /clear keeps compressed context
```

The number is how many tokens the conversation is using, as estimated by Claude Code. The bar shows how full the context window is and changes colour as it fills. In narrow windows the text gets shorter. The meter never does anything on its own.

## /wash

1. Type `/wash`. Claude writes a short brief: what you're doing, where things stand, and what to do next. The status line changes to `Brief ready ✓`.
2. Type `/clear`. The new session starts with that brief already loaded.

Your old conversation stays in `/resume`.

| Command | What it does |
|---|---|
| `/wash` | Write a `mid` brief |
| `/wash light` | Goal, current state, next step |
| `/wash mid` | Adds constraints, decisions, state detail, pitfalls |
| `/wash detailed` | Adds rationale, history, test results, risks, a step checklist |
| `/wash discard` | Drop the brief. `/clear` is a normal clear again |
| `/wash load [id]` | Make a waiting brief the one your next `/clear` uses |
| `/wash stats` | How much context your washes have saved |
| `/wash help` | Explain the meter and these options |

- Words after the level tell Claude what to focus on: `/wash mid focus on the failing test`.
- A `/clear` with no brief ready is a normal clear.
- Writing a brief is an ordinary Claude reply, so it uses tokens. `help`, `discard` and `load` don't.
- Each level has a size limit based on how big the conversation is. `/wash help` shows them.
- Closed the terminal before `/clear`? Start `claude` in the same folder and the brief loads. If more than one is waiting, you're shown which ones, with the `/wash load <id>` to pick one.
- Briefs expire after 48 hours.

## Stats

```sh
npx context-carwash stats
```

```text
Carwash stats, since 3 Oct 2026 (12 days)

  Briefs written              7  (light 1 · mid 5 · detailed 1)
  Started fresh with one      6
  Prompts in fresh sessions   94  (410 requests to Claude)
  Context not re-sent         ~21M tokens
  Spent writing briefs        ~0.9M tokens
  Net saved                   ~20M tokens
```

Every request to Claude re-sends the whole conversation. After a wash, each request starts from the small brief instead, so Carwash counts the requests you actually made and adds up the difference. Claude charges about a tenth for repeated context, so the money saved is roughly a tenth of these numbers. `/wash stats` shows the same inside Claude Code.

`npx context-carwash stats --share` sends your anonymous totals, but only after showing you exactly what it will send and you say yes.

## Something not working?

```sh
npx context-carwash doctor
```

This checks that everything is still installed and working, and shows your versions and recent errors. Paste the output into a [new issue](https://github.com/Spobi/context-carwash/issues/new). Issues are public, and errors can include folder names, so look it over first.

## Where things are kept

Briefs, stats and error logs are kept in `~/.carwash`, readable only by you. Nothing about you is uploaded. Once a day Carwash checks npm for a newer version. Set `CARWASH_NO_UPDATE_CHECK=1` to turn that off.

## Uninstall

```sh
npx context-carwash uninstall
```

This puts `settings.json` back exactly as it was. If you have edited the file since installing, it removes only Carwash's own status line and hooks and keeps your edits. It then removes the `/wash` command and deletes `~/.carwash`, including any briefs still waiting and your stats.

## Platforms

Developed and tested on macOS. Automated tests also run on Linux and Windows; neither has been tried by hand yet.

## License

MIT
