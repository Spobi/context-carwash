# M1 spike findings

Run on 2026-10-13 against Claude Code 2.1.296, macOS 27.0.1, zsh 5.9 and bash 3.2, with `TERM_PROGRAM=Apple_Terminal`. Every session ran in a throwaway sandbox project with hooks and the status line attached through `--settings`; interactive sessions were driven through a pseudo-terminal (`pty-drive.py`). Model: Haiku 5.5.

Nothing here was run on Linux or Windows.

## Confirmed

| Plan item | Result |
|---|---|
| Status line payload | `context_window` carries `used_percentage`, `remaining_percentage`, `context_window_size`, `total_input_tokens`, `total_output_tokens`, `current_usage`. `used_percentage` and `current_usage` are `null` until the first response. `session_id`, `transcript_path`, `model.id` are present. |
| `TERM_PROGRAM` visible to the status line | Yes. The process also gets `COLUMNS`, `LINES`, `COLORTERM`, `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`. |
| Truecolor | 24-bit colour sequences pass through unchanged. |
| OSC 8 links | Claude Code strips them itself when it sees `Apple_Terminal` and keeps them for `iTerm.app`, `vscode`, `ghostty`, or `FORCE_HYPERLINK=1`. A loopback `http://127.0.0.1` target survives intact. |
| `refreshInterval` | Set to 2, the status line re-ran every 2.0s while the session sat idle. |
| `/wash` with `$ARGUMENTS` | Works as a skill. `UserPromptExpansion` fires with `command_name: "wash"`, `command_args`, and a `prompt_id`. |
| Capturing the brief from the reply | `Stop` receives `last_assistant_message` (full text, tested to 11k characters) and the same `prompt_id` as the expansion, so the wash turn is identified exactly. One model request, no tool call. |
| Passing the budget to the command | `additionalContext` from the `UserPromptExpansion` hook reaches the model. |
| `/wash discard` and `/wash load` without a model turn | A `UserPromptExpansion` hook returning `decision: "block"` stops the prompt: zero turns, zero cost. On screen it reads `UserPromptExpansion operation blocked by hook: <reason>`. |
| Injection on `/clear` | `SessionEnd(reason=clear)` then `SessionStart(source=clear)` fire 54ms apart. `additionalContext` reaches the new session, and the old conversation is gone. |
| Visible line separate from model context | `systemMessage` renders as `SessionStart:clear says: <text>`; `additionalContext` goes only to the model. |
| Previous session id on `clear` | Not in the payload, but both hooks run under the same `CLAUDE_PID`, with the old and new `session_id` respectively. Matching by process id is exact. |
| Hook output cap | Real. 9,000 characters arrive whole. 15,000 are replaced by a 2KB preview plus the path of a copy Claude Code saves under the session directory. |
| Reading the over-cap brief | Claude reads Claude Code's saved copy with no permission prompt when the preview tells it to, on both `startup` and `clear`. |
| Headless fork | `claude -p --resume <id> --fork-session` leaves the source transcript byte-identical. With `--no-session-persistence` no new transcript is written. |
| Fork cache reuse | 24,040 tokens read from cache against 129 written (about 99.5%). |
| Fork during an in-flight turn | Safe. The fork sees the prompt but not the unfinished reply; the live session finishes normally. |
| Ending the session after `Stop` | A signal to `CLAUDE_PID` sent 400ms after the hook returns exits cleanly: terminal modes restored, `SessionEnd` fires, transcript valid and resumable. `SIGINT` exits 0, `SIGTERM` 143, `SIGHUP` 129. |
| Shell function relaunch | Under zsh 5.9 the prototype in `wrapper.sh` relaunched in the same terminal with `CARWASH_PENDING` set; the new session's `SessionStart` hook saw it and injected. The variables do not leak into the shell. |
| Flag replay | Tested under zsh 5.9 and bash 3.2 with a stub in place of the binary: `--resume <id>`, `--resume=<id>`, a bare `-r`, `-c`, and `--session-id <id>` were dropped; other flags, including one with a space in its value, were replayed. `--continue`, `--fork-session`, `--from-pr`, and `--teleport` share the same code path but were not in the test. |

## Changes the design needs

- **Do not store the brief where Claude must read it from `~/.carwash`.** A `Read` outside the project is permission-gated. Emit the whole brief as `additionalContext` instead: under 10,000 characters it lands inline, and over that Claude Code saves it and Claude reads the saved copy. The brief must open with its core (objective, state, next action) and the read instruction, inside the first 2KB.
- **The fork must keep its tools.** `--tools ""` dropped cache reads from 24,040 to 3,148 tokens. Use `--permission-prompts none` to keep it from acting.
- **Carwash's hooks fire inside the helper's fork** (`SessionStart` with `source=fork`, `UserPromptSubmit`, `Stop`, `SessionEnd`). The helper must mark its child process so they do nothing there.
- **A click during a turn yields a brief that omits that turn.** The helper should wait for `Stop` before generating.
- **A click while idle has no `Stop` to wait for** in the one-step flow, so the helper signals the session directly once the brief is ready.
- **A positional prompt is replayed on relaunch** (`claude "fix the bug"` would send it again). M5 needs an allowlist of replayable flags, or a fall back to the two-step flow when the arguments cannot be parsed with confidence.
- **Signal in-hook loses the last bookkeeping lines** of the transcript (32 lines against 34). Always signal from a detached process after the hook returns.

## Not verified

- Clicking links in a real terminal, and the click gesture. Deferred to the end of the project by decision.
- What the browser shows after a click (204 against a close-this-tab page). Needs a real browser.
- How the gradient looks in Terminal.app. The bytes are correct; whether the colours render is a visual check.
- `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID` are not in the hooks documentation. In every run `CLAUDE_PID` equalled the hook's parent process id, which is the fallback.
- `last_assistant_message` beyond 11k characters.
- Everything on Linux and Windows.

## Reproducing

```sh
export CARWASH_SANDBOX=/some/throwaway/dir
spikes/run.sh <name> -p "prompt" --model haiku --output-format json   # headless
python3 spikes/pty-drive.py steps.json raw.bin -- spikes/run.sh <name> --model haiku   # interactive
python3 spikes/render.py raw.bin 120 40                               # view the screen
```

Hook behaviour for a run is set in `$CARWASH_SANDBOX/out/<name>/behavior.json`; the format is described at the top of `log-hook.mjs`.
