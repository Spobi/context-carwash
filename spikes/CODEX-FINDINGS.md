# Codex findings

Run on 2026-10-15 against Codex CLI 0.162.1 (and 0.157.1 for the first headless run), macOS 27.0, with `gpt-5.6-luna` at low effort. Interactive sessions were driven through a pseudo-terminal with `pty-drive.py` and `render.py`. Hooks were attached with `-c hooks.<Event>=[...]` plus `--dangerously-bypass-hook-trust`, or through a trusted test project's `.codex/hooks.json`. The end-to-end runs used the real installer's output, installed into a sandbox `CODEX_HOME` and copied into the test project.

Nothing here was run on Linux or Windows.

## Confirmed

| Question | Result |
|---|---|
| Hooks available | Enabled by default (`features.hooks`, stable). `SessionStart`, `UserPromptSubmit`, `Stop` and others, configured in `hooks.json` or inline `[hooks]` in `config.toml`, per config layer. |
| Payloads | Every hook gets `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`. `SessionStart` has `source` (`startup`, `clear`, ...). `UserPromptSubmit` has `turn_id` and `prompt` (the text as typed). `Stop` has `turn_id`, `stop_hook_active`, `last_assistant_message`. |
| When `SessionStart` fires | Lazily: when the session's first prompt is submitted, a few ms before `UserPromptSubmit`, for `startup` and for `clear` alike. Nothing fires at `/clear` itself. `SessionEnd` fires only when Codex exits, once per session started. |
| `/clear` | "clear the terminal and start a new chat": a new `session_id` in the same process. `SessionStart` then has `source: "clear"`. |
| Process identity | The hook's parent is the native `codex` binary (the user's shell runs the command with `-lc` and hands over to it), the same process across `/clear`. On Windows Codex runs `cmd.exe /C`, which stays in between (from the source, not run). Codex passes its whole environment to hooks, so `CLAUDE_PID` and `CLAUDE_CODE_*` leak in when Codex is started from inside Claude Code. |
| `$wash` | A skill in `~/.codex/skills/<name>` or `~/.agents/skills/<name>` shows in the `$` menu; extra frontmatter (`metadata`, `argument-hint`) is tolerated. Typing `$wa` and Enter inserts `$wash `. The hook sees `prompt: "$wash light"`. `/wash` is refused by the TUI ("Unrecognized command") and never reaches a hook. |
| Blocking a prompt | `{"decision":"block","reason":...}` from `UserPromptSubmit`: no model turn, no `Stop`. Shown as `• Blocked by hook └ <reason>`, line breaks kept. |
| Adding context | `hookSpecificOutput.additionalContext` from `UserPromptSubmit` and `SessionStart` reaches the model as a developer message. The handoff answered from it after `/clear`. |
| Messages to the user | `systemMessage` from `Stop` and `SessionStart` shows as `↳ Hook · <text>`. |
| Asking for a shorter brief | `{"decision":"block","reason":...}` from `Stop` continues the same turn with the reason as the next prompt: same `turn_id`, `stop_hook_active: true` on the next `Stop`, and no `UserPromptSubmit` for it. |
| `codex exec` | Fires the same hooks, `source: "startup"`. The Codex process's command line has `exec`, which is how Carwash tells it apart. Confirmed live: a waiting brief stayed waiting through an `exec` run, then loaded in the next interactive session. |
| Hook trust | New or changed hooks are skipped until trusted. At startup Codex asks: "Hooks need review · 1. Review hooks 2. Trust all and continue 3. Continue without trusting". Trust is written to `config.toml` as `[hooks.state."<hooks.json path>:<event_snake_case>:<group>:<handler>"] trusted_hash = "sha256:..."`. `[hooks.state]` alone does not trigger Codex's "hooks in both hooks.json and config.toml" warning; only inline hook definitions do. |
| Context in use | The session file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) has an `event_msg` `token_count` after each request: `info.last_token_usage.input_tokens` (context sent) and `info.model_context_window`. Newer files also have `token_usage_record` per response (`response_id`, `thread_id`), and prompts as `item_completed` items of type `UserMessage`. A fresh Codex session starts at about 14k tokens. |
| Status line | `tui.status_line` takes built-in item names only (`context-used`, `used-tokens`, ...), no command. No meter is possible. |
| Hook cost | `carwash hook codex` on a plain prompt takes 40–80 ms. |

## Not verified

- Anything on Linux or Windows. The Windows parent lookup (one PowerShell call) is covered only by the automated tests on GitHub's Windows runner.
- A brief over Codex's 2,500-token default inline limit: `additionalContextLimit: 0` is set so it passes whole, per the docs, but no brief that long was delivered.
- The Codex IDE extension and desktop app, which share `~/.codex` and run hooks through the app server.
- The trust hash: Codex hashes a TOML form of the hook, so doctor only checks that an approval exists for each of Carwash's hooks, not that it matches.
