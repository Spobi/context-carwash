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
- **Platforms:** macOS, Linux, and Windows. The one-step shell function stays zsh/bash only (section 6.3).
- **Brief capture for typed `/wash` (replaces "write to a private temp file" in 6.1):** Claude prints the brief as its reply and a `Stop` hook saves it from `last_assistant_message`. No tool call and no permission change.
- **Brief delivery (amends 6.2 and 7):** hook-injected context is capped at 10,000 characters with no setting to raise it. The `SessionStart` hook emits the whole brief. Under the cap it arrives inline. Over it, Claude Code keeps a 2KB preview and saves the rest in the session directory, which Claude can read without a permission prompt; a file under `~/.carwash` would prompt. Every brief therefore opens with its core (objective, state, next action) and a read-the-full-copy instruction inside the first 2KB.
- **Idle refresh (amends "no polling" in section 4):** the installer sets a low-rate `statusLine.refreshInterval` so click-triggered states appear while the session is idle. Each tick is a local file read; still no model calls in the renderer.
- **Previous session id on `clear`:** not in the `SessionStart` payload, but the old and new sessions' hooks share one `CLAUDE_PID`. The two-step flow matches on that process id, so the worktree rule in section 7 only applies to a brief picked up by a different process.
- **M1 results:** every SPIKE in sections 4 to 8 is resolved in `spikes/FINDINGS.md`, apart from real link clicks and the helper's browser response. The one-step flow ends the session with `SIGINT` to `CLAUDE_PID`, sent after the `Stop` hook returns. Headless generation uses `--fork-session --no-session-persistence --permission-prompts none` and must not change the tool list.
- **Click-link verification:** deferred to the end of the project (VS Code terminal, iTerm2, Ghostty). Checkpoint testing happens in Terminal.app, which exercises the typed-command fallback.
- **Repository:** MIT license, private GitHub repository until release, one commit per milestone.

## 15. References

- Status line: https://code.claude.com/docs/en/statusline
- Hooks: https://code.claude.com/docs/en/hooks
- Commands: https://code.claude.com/docs/en/commands
- Skills/custom commands: https://code.claude.com/docs/en/skills
