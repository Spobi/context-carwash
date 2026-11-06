# Changelog

## 0.2.4

- You can name what a brief must keep: `/wash keep the exact error and the rollback plan`. Claude puts it in a **Kept on request** section right after Core, keeps exact wording for errors, commands and paths, and cuts other sections first when the brief is too long. A note on its own gets a `mid` brief; to pick the level, put it first, as in `/wash detailed keep the test names`. The same works with `$wash` in Codex.
- A note can start with a word that is also a command: `/wash help me keep the API notes` writes a brief instead of showing help. `help` and `stats` are commands only when nothing follows them, and `load` and `discard` only with at most an id.
- Likely typos cost nothing: `/wash detaled` or `/wash discrad a3f9c2` asks "Did you mean…?" instead of writing a brief.
- `/wash help` shows how to add a note.
- Run `npx context-carwash@latest install` to get the new `/wash` instructions.

## 0.2.3

- A fresh session can now search the old conversation. When a brief is saved, Carwash keeps a text copy of the conversation in `~/.carwash/recall`, without images, and tells the fresh session where it is, so it can look up an exact error message, path or number the brief left out. The copy is deleted after 7 days, or when you discard the brief. Nothing goes in your project.
- `install` adds one permission to `~/.claude/settings.json` so Claude can search that folder without asking. It allows reading that folder and nothing else, and `uninstall` takes it out. `carwash doctor` checks it. Run `npx context-carwash@latest install` to get it.
- `carwash stats` now gives the right cached price on Claude: a twentieth of the normal input price on Opus 5.5 and Sonnet 5.5, not a tenth.

## 0.2.2

- `carwash stats` leads with a likelier saving and shows the old figure as the most it could be. It counts only the first part of the prompts after each wash, since you would have cleared the old conversation at some point anyway. That share starts at two-thirds and is learned from how far your own Claude Code conversations go, read on your machine. Output the fresh conversation had to read again, which the old one already had, is taken off.
- `stats --share` sends the likely figure as well as the full one.

## 0.2.1

- Codex support. `install` sets up Codex too when it finds it: three hooks in `~/.codex/hooks.json` and a `$wash` command in `~/.codex/skills/wash`. Codex asks you to trust the hooks once. After `/clear`, the brief loads with your next message. Codex's status line can only show its own items, so the meter is a line after each reply instead, in colour from Codex 0.162.0 on. It is shown to you only and costs no tokens.
- `carwash doctor` checks the Codex hooks, whether Codex trusts them, and `$wash`.
- `carwash stats` counts Codex sessions too.
- Claude Code works exactly as before. A brief from one tool is not picked up by the other unless you load it by id.

## 0.2.0

- README demo GIF and a one-line summary at the top.
- Fixed a test that started failing 48 hours after its fixed test date.

## 0.1.9

- Friendlier README wording.

## 0.1.8

- Shorter, clearer README.

## 0.1.7

- `carwash doctor` checks that the Node Carwash runs with is still there, and says how to fix it if not. Removing that Node, for example an old version in nvm, stops the meter and `/wash` until install is run again. The installer now says which Node that is.
- Clearer wording on when Carwash goes online, and a reminder to look over `doctor` output before posting it in a public issue.

## 0.1.6

- Update notices: once a day, a new session checks npm in the background. A line under the meter says when a newer version is out, or when the version you have carries a warning. `CARWASH_NO_UPDATE_CHECK=1` turns it off.
- `carwash doctor`: checks the install and prints versions and recent errors, ready to paste into a bug report.
- The status line says when a hook has failed, until `doctor` has shown the error.
- `/wash help` shows the version you have.

## 0.1.5

- `stats --share` sends to the Context Carwash Google Form.

## 0.1.4

- `carwash stats` and `/wash stats`: how much context `/wash` has kept from being sent again, measured from the fresh sessions' transcripts.

## 0.1.3

- An out-of-date installer hands over to the newest release.

## 0.1.2

- The installer says when a newer version is on npm.

## 0.1.1

- Shorter welcome note. Status line hints are sized to the window.

## 0.1.0

- First release on npm: the context meter, the installer and uninstaller, `/wash`, and brief delivery on `/clear`.
