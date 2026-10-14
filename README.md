# Context Carwash

Context Carwash adds a line to Claude Code in your terminal that:

1. **The Meter:** shows the current conversation's context size.
2. **/wash:** lets you compress your context and start a new session without losing important details.

Pretty simple app, but I've found it helpful. Everything is local, but you can share your token savings anonymously with me if you'd like with `npx context-carwash stats --share`.

## Install

You'll need Node 18 or later.

```sh
npx context-carwash install
```

It shows you what it's going to change and asks before doing anything. Then start a new Claude Code session and you're set.

When there's a new version, a line under the meter will tell you. To update, run `npx context-carwash@latest install`.

Under the hood, it adds a status line and three hooks to `~/.claude/settings.json` (after whatever you already have there) and a `/wash` command in `~/.claude/skills/wash`.

## The Meter

```text
session context ~136k  [██████████░░░░░]  /wash to compress & save context, then /clear keeps compressed context
```

The number is roughly how many tokens your conversation is using (Claude Code's estimate). The bar shows how full the context window is and changes colour as it fills up. In a narrow window the text shortens to fit. It's just a meter, so it never does anything on its own.

## /wash

1. Type `/wash`. Claude writes a short brief: what you're working on, where things stand, and what's next. The status line switches to `Brief ready ✓`.
2. Type `/clear`. Your new session starts with the brief already loaded.

Your old conversation isn't gone. You can still find it in `/resume`.

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

A few things worth knowing:

- You can tell Claude what to focus on: `/wash mid focus on the failing test`.
- If you `/clear` without a brief ready, it's just a normal clear.
- Writing a brief is a normal Claude reply, so it uses some tokens. `help`, `discard` and `load` are free.
- Bigger conversations get bigger briefs. `/wash help` shows the size limit for each level.
- Closed the terminal before you got to `/clear`? Run `claude` in the same folder and your brief loads. If there's more than one waiting, it'll list them so you can pick with `/wash load <id>`.
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

Every request to Claude sends the whole conversation again. After a wash, each request starts from the small brief instead, so Carwash counts the requests you actually made and adds up the difference. Claude charges about a tenth of the price for repeated context, so in dollars you're saving roughly a tenth of these numbers. You can also see this inside Claude Code with `/wash stats`.

If you run `stats --share`, it shows you exactly what it would send before asking.

## Something not working?

```sh
npx context-carwash doctor
```

This checks that everything's still installed and working, and shows your versions and any recent errors. Paste the output into a [new issue](https://github.com/Spobi/context-carwash/issues/new) and I'll take a look. Issues are public and errors can include folder names, so give it a quick read first.

## Where things are kept

Your briefs, stats and error logs live in `~/.carwash`, and only you can read them. Nothing about you gets uploaded. Once a day, Carwash checks npm for a newer version. If you'd rather it didn't, set `CARWASH_NO_UPDATE_CHECK=1`.

## Uninstall

```sh
npx context-carwash uninstall
```

This puts `settings.json` back exactly as it was. If you've edited the file since installing, it only removes Carwash's status line and hooks and leaves your changes alone. It also removes the `/wash` command and deletes `~/.carwash`, including any waiting briefs and your stats.

## Platforms

Built and tested on macOS. Automated tests also run on Linux and Windows, but I haven't tried those by hand yet.

## License

MIT
