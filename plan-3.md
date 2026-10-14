# Context Carwash — Product and Implementation Plan (v3)

Supersedes `plan-2.md`. Decisions below were made in discussion; items marked **SPIKE** must be verified before being relied on.

## 1. Product summary

**Context Carwash** (`context-carwash`) is a small, open-source, local-first utility for Claude Code. It does two things:

1. **Meter:** shows a quiet, always-visible estimate of the active context window in Claude Code's status line.
2. **Wash:** when the user deliberately asks, writes a bounded, file-focused handoff brief and starts a fresh session that begins with that brief.

Not automatic, ever. A full meter is information, not an instruction. No nudges, tips, notifications, or thresholds that trigger anything.

- Project/package name: `context-carwash`
- Slash command: `/wash` (levels: `light`, `mid` default, `detailed`)
- CLI binary: `carwash`
- Rolling/incremental compression is out of scope for v1.

## 2. Principles

- Minimal and quiet. No persistent dashboard.
- Local-first: no accounts, telemetry, cloud, or project uploads.
- No handoff files in the repository. Storage lives outside the project, with restrictive permissions.
- Plain `claude` must keep working. Users are never required to launch through a different command.
- Never break what the user already has: existing status line, existing `claude` alias/function, existing hooks. Wrap, never overwrite. Everything is reversible.
- Normal `/clear` remains a normal clear. Carwash only acts when a brief is ready and the user has asked for it.
- Never discard source-session recovery information. Claude Code persists transcripts, so the old session stays resumable with `/resume`.
- Do not bypass or broaden Claude Code permissions. A relaunch reuses the original flags.
- Make uncertainty visible: token counts are estimates; percentage is not a measure of model quality.

## 3. What Claude Code allows (verified against docs)

- Hooks cannot clear a session, start one, run a slash command, or inject keystrokes. Hooks run without a controlling terminal.
- Skills/custom commands are prompts. They cannot invoke built-ins such as `/compact` or `/clear`.
- `SessionStart` input has `source`: `startup`, `resume`, `clear`, `compact`, `fork`. It accepts `hookSpecificOutput.additionalContext`.
- `SessionEnd` input has `reason`, including `clear`. Default timeout is 1.5s unless raised.
- `PreCompact` can block compaction; `PostCompact` receives `compact_summary` but cannot alter the result. Neither is used for restart.
- `Stop` fires when a turn ends (the idle-boundary signal). `UserPromptExpansion` fires for user-typed commands that expand into prompts.
- A custom command may take arguments (`$ARGUMENTS`), which is how `/wash light|detailed` works.

Consequence: with plain `claude`, a one-step reset is not possible through supported interfaces. v1 therefore ships two flows (section 6).

## 4. Status line

Uses Claude Code's native `statusLine` command, which supplies JSON including `context_window.used_percentage`, `context_window.context_window_size`, `context_window.current_usage`, `session_id`, `transcript_path`.

Example (136k used of 200k):

`ctx 68%  ~136k/200k  [██████████░░░░░]  Compress & New Session: light ≤1.4k · mid ≤4.1k · detailed ≤13.6k`

- Only `light`, `mid`, `detailed` are OSC 8 links. Each shows its estimated brief cap (1% / 3% / 10% of used context) beside it.
- Denominator comes from the reported window size; no hardcoded model limits.
- Smooth deep-green → yellow → orange → deep-red gradient, interpolated between anchors: 0% `#176B42`, 45% `#A9A91D`, 60% `#D97926`, 75% `#C43D32`, 90–100% `#741A22`. Colors are display only.
- Narrow terminals degrade in this order: drop token estimates → drop bar → percentage only.
- Event-driven, fast; no polling and no LLM calls in the renderer.
- No nudges, flashing, or notifications at any threshold.
- Status transitions shown inline: `washing…` → `Brief ready ✓ mid ~3.1k · type /clear to start fresh with it. Old session stays in /resume.` After generation the estimate is replaced with the measured size.
- **Terminal.app:** it does not support OSC 8 links. If `TERM_PROGRAM=Apple_Terminal` (**SPIKE**: confirm env is visible to the status-line process), show plain text instead: `Terminal.app can't click links. Type /wash light | mid | detailed`. This is on screen permanently so users cannot forget.
- Terminals without link support get the same text fallback. Link label names the modifier (`⌘-click` on macOS, `Ctrl-click` elsewhere).

### Existing status line

At install, detect an existing `statusLine` command. Back it up, then wrap it: run theirs with the same stdin, append Carwash's segment. Uninstall restores the original byte-for-byte.

## 5. Presets and budgets

Percent of **currently used** context, not window capacity:

| Level | Cap | Content scope |
|---|---:|---|
| `light` | 1% | goal, critical constraint, current state, immediate next step |
| `mid` (default) | 3% | adds constraints, key decisions, current-state detail, pitfalls, next action |
| `detailed` | 10% | adds rationale, useful experiment history, key test results, risks, step checklist |

- Pure percentages. No floor, no absolute hard cap. Users with small sessions choose `detailed`.
- Caps are ceilings, not targets. Scope (what categories are included) is what keeps briefs small; the cap is a safety bound. The generation prompt says: write the smallest brief that lets a fresh session continue; stop when done; typical output well under the cap.
- Size is measured after generation and reported (e.g. "1.1k of 4.1k cap"). If over cap, compress again; never silently exceed.
- The count covers the brief only, not the new session's baseline system prompt and tool definitions; the UI says so.

## 6. Flows

### 6.1 Brief generation (both flows)

- **`/wash [level]`** (typed): the live session writes the brief. This uses the warm prompt cache and is the cheapest path. The command's prompt instructs Claude to write the brief to a private temp file and print a one-line confirmation.
- **Link click** (status line): a short-lived loopback helper generates headlessly via `claude -p --resume <session_id> --fork-session` (**SPIKE**: confirm cache reuse and that an in-flight turn is handled safely). Claude's live session is not involved.
- Both write the same pending record (section 7) and converge on the same delivery.

### 6.2 Two-step flow (default; works with plain `claude`)

1. User runs `/wash [level]` or clicks a level link. A brief is generated; status line and command output say: `Brief ready ✓ — type /clear to start fresh with it. This is not a normal clear: your brief carries over. Old session stays in /resume.`
2. User types `/clear`. `SessionEnd(reason=clear)` and `SessionStart(source=clear)` fire; the hook injects the brief via `additionalContext` and shows a visible line: `Loaded your Carwash brief (mid, 2m ago).`
3. If no brief is ready, `/clear` is untouched and nothing is injected.
4. `/wash discard` drops a pending brief.

### 6.3 One-step flow (optional shell function; offered at install, default yes)

The installer adds a small marked block to `.zshrc`/`.bashrc` defining a `claude` function. Users keep typing `claude`. The real binary is untouched.

1. The function runs the real `claude` with inherited stdio (no TUI reimplementation) and sets `CARWASH_WRAPPED=1`.
2. After `/wash` or a click produces a ready brief, and once the turn is idle (`Stop` hook), the session is ended cleanly and the function relaunches `claude` in the same terminal with the original flags and `CARWASH_PENDING=<id>`.
3. `SessionStart` matches that exact ID. No heuristics needed.
4. Original flags are replayed minus session-specific ones (`--resume`, `--continue`); permissions are neither widened nor narrowed.

**SPIKES (first thing to prove):** clean termination of the old process after `Stop` with transcript intact and terminal modes restored; which args are safe to replay; never relaunching mid-stream or mid-tool; behavior with the existing-alias cases below.

**Existing alias/function:** installer inspects what `claude` currently resolves to. If found, wrap the user's definition so their flags still apply, or decline and print integration steps. Never silently overwrite.

**Coverage:** IDE extensions, the desktop app, other shells (fish, PowerShell), and scripts that call the binary directly fall back to the two-step flow. Typing `command claude` bypasses the function on purpose.

## 7. Multi-session safety and delivery

Everything is keyed by identity, never "most recent."

Pending record, stored outside the project (e.g. `~/.carwash/pending/<id>.json`, mode 0600, directory 0700):

- source `session_id`, `transcript_path`
- canonical cwd and git worktree root, branch
- created time, level, one-line title
- HEAD sha and dirty flag at creation
- state: `ready` → `consumed` | `expired`

Matching in the `SessionStart` hook (events handled: `startup` and `clear` only; never `compact`, `resume`, `fork`):

- With `CARWASH_PENDING` set: exact match by ID.
- Otherwise consider only `ready` records for the same worktree root.
- **One match, under 12h old:** inject the brief and show the visible "Loaded…" line.
- **Several matches, or older than 12h (up to a 48h expiry):** inject nothing automatically. Show a one-line pointer listing candidates (title, time, id) so the user can run `/wash load <id>`. We prefer losing context to loading the wrong context.
- Claiming is atomic: the record flips to `consumed` on injection, so two new sessions cannot both receive it.
- Staleness: on injection, compare current HEAD/dirty state to the record and add one line if the repo moved (`repo changed since this brief: HEAD abc→def`).
- Consumed records are retained for a short, configurable period for recovery, then purged. Expired records are purged.

**SPIKES:** whether the `clear` hook payload exposes the previous session id (would make matching exact without the launcher); whether `systemMessage` is shown to the user from `SessionStart`; whether the visible line can be delivered separately from model context.

## 8. Click links and the loopback helper

- Helper is ephemeral: started lazily by the status-line renderer, idle-exits after N minutes, binds to `127.0.0.1` only.
- Each link carries a single-use nonce minted by the status line. No state change on GET-style prefetch; per-session token; reject foreign hosts/origins.
- **Idempotent:** a repeat click within N minutes returns the existing brief instead of regenerating.
- **Debounced:** double-clicks and a second preset click while one is generating are ignored or queued.
- A click only ever generates. It never clears, kills, or restarts on its own; in the two-step flow the user types `/clear`, and in the one-step flow the relaunch is the same user-requested wash completing at an idle boundary.
- **SPIKE:** whether a 204-style response avoids leaving a blank browser tab; otherwise a minimal "Done — you can close this tab" page.
- There is no embedded UI and no persistent page.

## 9. Brief content rules

Task-oriented, not a transcript summary. Include only what improves continuation:

1. Objective and acceptance criteria.
2. Constraints and user corrections/preferences relevant to the task.
3. Decisions and rationale (rejected approaches only when the reason remains useful).
4. Source-of-truth state: files/branches changed, commands and tests run, results, blockers, uncommitted work.
5. Pitfalls, unresolved assumptions, failed approaches worth not repeating.
6. One concrete next action.

Rules: **reference files, diffs, and tests by path rather than copying content**; omit greetings, repetition, stale plans, raw tool output; separate confirmed facts from assumptions; never invent test results or claim to have inspected unseen files; do not copy credentials or secrets.

## 10. Install, uninstall, privacy

- **One installer, one accept step.** It lists exactly what it will change: wrapped status line, `/wash` command and hooks in Claude Code settings, and (optional, default yes) the shell block. Shell path adds a "open a new terminal" note.
- Config is backed up before editing; uninstall restores it, removes the shell block (marked comment lines), and deletes `~/.carwash`.
- All helper traffic is loopback; no telemetry; no cloud dependency; no permanent files in repos.
- Handoff generation has a model/token cost; docs and UI say so. The next session receives only the brief.

## 11. Milestones

### M1 — Feasibility spikes (do first)
- Status-line payload and gradient rendering; `TERM_PROGRAM` visibility; OSC 8 behavior in target terminals and exact gestures.
- `/wash` command with `$ARGUMENTS`, writing a brief from the live session without extra model turns beyond the work itself.
- `SessionStart` injection on `clear`; user-visible message; previous-session-id availability.
- Headless `--resume --fork-session` generation and cache reuse.
- Clean-exit-and-relaunch via shell function; terminal restoration; arg replay; alias handling.
- Helper response behavior (204 vs. close-page).

### M2 — Meter
Renderer with robust missing-field defaults, gradient, width handling, link labels and estimates, Terminal.app fallback, install/uninstall with wrap-and-restore.

### M3 — `/wash` and two-step delivery
Command, pending store, `SessionStart` matching rules, visible confirmations, `/wash discard`, `/wash load`, staleness line.

### M4 — Click links
Ephemeral helper, nonces, idempotency, debounce, generation via fork, status-line state transitions.

### M5 — One-step shell flow
Function install block, existing-alias detection, idle detection via `Stop`, clean relaunch, fallback coverage.

### M6 — Reliability and release
Tests: budget enforcement, no-padding (small session stays well under cap), malformed status-line input, terminal width, helper security, duplicate clicks, helper timeout, model failure, relaunch failure and recovery, concurrent sessions in same and different folders, day-later pickup, plain `/clear` with no brief. README: install, supported terminals, limitations, privacy, uninstall, troubleshooting, demo.

## 12. Acceptance criteria

- The meter is visible and updates from Claude Code's reported state; gradient is smooth; nothing happens automatically.
- `/wash`, `/wash light`, `/wash detailed` work without clicking anything; default is `mid`.
- Clicking a level link generates the same kind of brief; repeat and double clicks do not duplicate work.
- With plain `claude`, `/wash` followed by `/clear` starts a fresh session containing the brief, with an unmistakable on-screen explanation that the clear carries the brief over.
- With the shell function, one `/wash` (or click) results in a fresh session in the same terminal with no extra command.
- A plain `/clear` with no brief ready behaves exactly as before.
- Multiple concurrent sessions never receive the wrong brief; ambiguity results in a pointer, not an injection.
- Briefs stay within the preset percentage, are not padded, and report actual size.
- Existing status lines and `claude` aliases/functions keep working; uninstall restores everything.
- Terminal.app and other link-less terminals show the typed-command fallback on screen.
- No telemetry, accounts, cloud dependency, or custom TUI.

## 13. Out of scope for v1

Rolling/incremental checkpoints; automatic restarts or thresholds; nudges and notifications; persistent dashboards; custom TUI; cloud sync; automatic approval of tools; absolute hard caps and floors (percentages stand alone).

## 14. Amendments (2026-10-13)

Decisions made after v3 was written. Where these conflict with the sections above, these win.

- **Runtime:** Node 18+, plain JavaScript, zero dependencies, distributed via npm.
- **Platforms:** macOS, Linux, and Windows. The one-step shell function stays zsh/bash only (section 6.3). Development and checkpoint testing happen on macOS. Linux and Windows are covered by automated tests on GitHub's runners from M2 on, and Windows gets a hand test by a volunteer once the project is finished.
- **Brief capture for typed `/wash` (replaces "write to a private temp file" in 6.1):** Claude prints the brief as its reply and a `Stop` hook saves it from `last_assistant_message`. No tool call and no permission change.
- **Brief delivery (amends 6.2 and 7):** hook-injected context is capped at 10,000 characters with no setting to raise it. The `SessionStart` hook emits the whole brief. Under the cap it arrives inline. Over it, Claude Code keeps a 2KB preview and saves the rest in the session directory, which Claude can read without a permission prompt; a file under `~/.carwash` would prompt. Every brief therefore opens with its core (objective, state, next action) and a read-the-full-copy instruction inside the first 2KB.
- **Idle refresh (amends "no polling" in section 4):** the installer sets a low-rate `statusLine.refreshInterval` so click-triggered states appear while the session is idle. Each tick is a local file read; still no model calls in the renderer. It is added in M4 with the click links, since nothing before then needs it.
- **Install location (M2):** the installer copies the package to `~/.carwash/app` and points settings there, so the status line survives an npx cache being cleared or a Node version being removed.
- **Narrow-terminal order (M2, refines section 4):** brief caps go first, then the used/total count, then the Terminal.app sentence, then the bar, then everything but the percentage. Once the Terminal.app sentence no longer fits, the count comes back if there is room for it.
- **Uninstall (M2, refines section 10):** `settings.json` is restored byte-for-byte when it still holds exactly what the installer wrote. If the user edited it after installing, uninstall undoes only the `statusLine` key and keeps their edits.
- **Previous session id on `clear`:** not in the `SessionStart` payload, but the old and new sessions' hooks share one `CLAUDE_PID`. The two-step flow matches on that process id, so the worktree rule in section 7 only applies to a brief picked up by a different process.
- **M1 results:** every SPIKE in sections 4 to 8 is resolved in `spikes/FINDINGS.md`, apart from real link clicks and the helper's browser response. The one-step flow ends the session with `SIGINT` to `CLAUDE_PID`, sent after the `Stop` hook returns. Headless generation uses `--fork-session --no-session-persistence --permission-prompts none` and must not change the tool list.
- **Click-link verification:** deferred to the end of the project (VS Code terminal, iTerm2, Ghostty). Checkpoint testing happens in Terminal.app, which exercises the typed-command fallback.
- **Repository:** MIT license, private GitHub repository until release, one commit per milestone.

### M3 decisions (2026-10-13)

Made while building `/wash` and checked against Claude Code 2.1.296. Where these conflict with sections 6 and 7, these win.

- **Who a brief belongs to:** the terminal that asked for it, meaning the Claude Code process, identified by `CLAUDE_PID` plus the process start time where the system can report one. Every session in that terminal sees `Brief ready`, and that terminal's next `/clear` delivers it. A terminal holds at most one ready brief: washing again in the same session replaces the earlier one, and anything else it held goes back to waiting for its folder.
- **`/clear` only ever delivers the terminal's own brief.** The folder rule in section 7 applies at `startup` only. A `/clear` in a terminal that did not ask for a brief stays a normal clear, even when a brief is waiting for that folder.
- **Pickup by a new terminal (`startup`):** a brief is loaded only when it is the one brief waiting for that folder, it is under 12 hours old, and the process that owned it has exited. In every other case nothing is loaded and one line lists what is waiting with the `/wash load <id>` to use.
- **Unattended sessions never take a brief.** A `claude -p` run starts with `source: startup` too, so it is skipped when `CLAUDE_CODE_SESSION_ATTENDED` is `0` or the entry point is the SDK.
- **`/wash load [id]` and `/wash discard [id]`** are answered by the `UserPromptExpansion` hook and never reach Claude. `load` makes a waiting brief, or one delivered in the last 24 hours, the brief this terminal's next `/clear` uses. It does not inject mid-session: starting fresh stays a `/clear`. Ids are six hex characters, and the start of one is enough.
- **Recognising the brief:** the reply must open with a `# Carwash brief: <title>` heading, and the `Stop` hook's `prompt_id` must match the `/wash` prompt's. A reply without the heading saves nothing and says so.
- **Size and caps:** there is no tokenizer in a zero-dependency package, so size is estimated at 3.5 characters per token, which errs towards over. A brief over its cap is sent back through `Stop` hook feedback for shortening, at most twice. If still over it is kept and labelled as over the cap.
- **Idle refresh moved up from M4:** `statusLine.refreshInterval` is set to 5 seconds now. A command answered by the hook does not redraw the status line, so without it the line kept saying `Brief ready` after `/wash discard`. A refresh interval the user already set is kept.
- **Retention:** a waiting brief expires after 48 hours. A delivered brief is kept for 24 hours (`CARWASH_RETAIN_HOURS`) and can be loaded again.
- **What install adds:** three hooks (`SessionStart` for `startup|clear`, `Stop`, `UserPromptExpansion` for `wash`), each with a 20-second timeout, and the `/wash` skill at `~/.claude/skills/wash` with `disable-model-invocation`, so Claude can never run it on its own. Install refuses if a `/wash` command that is not Carwash's already exists.
- **Words after the level** (`/wash mid focus on the auth bug`) are passed to Claude as a note on what to emphasise.

### Meter shows tokens, not a percentage (2026-10-13)

Decided by the user after testing M3: a percentage is nebulous and people do not know what it stands for, so the meter gives the tokens in use instead. This replaces the `ctx 68%  ~136k/200k` form in section 4 and the narrow-terminal order above.

- The reading is `ctx ~136k/200k`: tokens in use, then the window size. Thousands are shortened (`20k`, not `20,000`). Before the first reply it is `ctx --`.
- No percentage appears anywhere in the status line. The bar and its colour still follow the proportion.
- Narrow terminals lose the brief caps first, then the window size (`ctx ~136k`), then the Terminal.app sentence (which gives the window size its room back), then the bar, then everything but the count.

### A self-explanatory meter (2026-10-14)

Decided by the user after reviewing what a newcomer could not work out from the row: it said what to type, but not what `/wash` does, that `/clear` is the second step, or what the numbers meant. This replaces the wording and narrow-terminal order in the section above.

- The reading is `context ~136k`: the full word, not `ctx`, since it costs only four columns. The window size (`/200k`) is no longer shown, because the bar already says how much of the window is used.
- The invitation is `/wash to compress & save context, then /clear`. In order of narrowing, it shortens to `/wash to compress, then /clear` (which keeps an 80-column window, the Terminal.app default, meaningful) and then `/wash, then /clear`. The levels and their caps leave the row: the command menu's argument hint lists the levels, and `/wash help` gives the caps. The dormant click-link form keeps its caps.
- The Terminal.app sentence is gone. Links are not built yet, so it apologised for a feature no terminal has.
- From 75% of the window on, the meter adds `getting full ·` before the invitation. It is display only, like the colour, and it is not shown while a wash is under way or a brief is ready. It outlasts the invitation and the bar at narrow widths.
- Narrow terminals shorten the invitation in two steps, then lose the bar, then everything but the count (and `getting full`, when it applies).
- **`/wash help`** is answered by the `UserPromptExpansion` hook like `discard` and `load`, so it costs nothing. It explains `/wash` and `/clear`, each level with its cap for the current session, and the meter.
- **First-run welcome:** the first attended `startup` or `clear` after install that has nothing else to say prints a short note through `SessionStart`'s `systemMessage`, then never again. A `~/.carwash/welcomed` marker, created exclusively, records it, so two sessions starting together cannot both show it. Uninstall deletes the marker with `~/.carwash`, so a reinstall shows it again. Checked live on Claude Code 2.1.299: line breaks in a `systemMessage` and in a block reason render as separate lines.
- **Loaded message:** when the old session's size was known, it adds `down from ~136k in the old session`. That number is the reading the brief was sized from. The new session's own size is not known at `SessionStart`, so no "saved" figure is claimed.
- **Stats (2026-10-14):** a ledger in `~/.carwash/stats/`, one small file per brief written, records its level, what writing it cost (attempts × (old session + brief)), and the fresh sessions it was delivered to with their transcript paths. Savings are measured from those transcripts: each request in the fresh session saved (old session size − fresh session's first request size). Counting stops at a compaction in the fresh session, or once that request plus the gap would pass 90% of the window (where the old session would have compacted on its own). `carwash stats` and `/wash stats` (hook-answered, free) show the totals, with a note that cached context is billed at about a tenth. The ledger keeps no brief text or prompts. A session start re-measures at most once a day, so transcripts are read before Claude Code deletes them.
- **Sharing:** `carwash stats --share` shows every field, asks, and then posts totals (a random share id, version, OS, days, briefs, prompts, tokens not re-sent, tokens spent) to a Google Form. It is the only network use besides the installer's version check. Until the form's ids are filled in (`FORM` in `src/stats/report.mjs`), it says sharing is not switched on and sends nothing.

## 15. References

- Status line: https://code.claude.com/docs/en/statusline
- Hooks: https://code.claude.com/docs/en/hooks
- Commands: https://code.claude.com/docs/en/commands
- Skills/custom commands: https://code.claude.com/docs/en/skills
