---
name: wash
description: Context Carwash. Writes a short handoff brief of this session, so that /clear can start a fresh session that carries on from it.
argument-hint: "[light | mid | detailed] [what to keep] | discard | load <id> | stats | help"
disable-model-invocation: true
metadata:
  installed-by: context-carwash
---

The user typed /wash. They want to start a fresh session that picks up where this one leaves off. Your whole reply to this message is saved as the handoff brief, and it is the first thing the next session reads. That session cannot see this conversation. It can search a saved copy for an exact detail, but only if it knows to look, so the brief has to stand on its own.

Arguments: $ARGUMENTS

Carwash's hooks send a line with this command that starts with "Carwash: level". It gives the level for this brief (`light`, `mid`, or `detailed`), its token ceiling, and the user's note on what the brief must keep, if they wrote one. Go by that line, not by the arguments above. If there is no such line, Carwash's hooks are not running: write no brief, and tell the user in one sentence to run `carwash install` again.

Reply with the brief and nothing else: no preamble, no closing remark, no code fence around it. Do not call tools or read files to prepare. Write from what is already in this conversation.

## Format

Start with exactly this heading, then the Core section:

```
# Carwash brief: <the task, in under 60 characters>

## Core
- Objective: what the user is trying to get done, and how they will know it is done
- State: where things stand right now
- Next: the one concrete action to take first
```

Core must stand on its own in under 1,000 characters. A session that reads only Core should still start in the right place.

If the user wrote a note, put a **Kept on request** section straight after Core, at every level. It holds everything the note asks for that this conversation has, with the exact wording of error messages, commands, paths, and numbers. If the note asks for something this conversation does not have, say so in one line instead of guessing. Never drop or shorten anything here to save space: cut from the other sections instead. Secrets stay out even when the note asks for them.

After that, add only the sections for the level, and skip any that would be empty:

- `light`: no other sections. Add one line for a critical constraint if breaking it would undo the work.
- `mid`: **Constraints** (the user's corrections and preferences that still apply), **Decisions** (what was settled, with the reason in a clause), **State** (files and branches changed, commands and tests run with their results, uncommitted work, blockers), **Pitfalls** (what to avoid, and approaches that failed).
- `detailed`: everything in `mid`, plus **Rationale** for the main decisions, **History** (experiments worth knowing about and what each one showed), **Test results**, **Risks and open assumptions**, and **Steps** (a checklist of what remains).

## Rules

- Write the smallest brief that lets a fresh session continue, and stop when it is complete. The token ceiling given with this command is a limit, not a target. Most briefs should end well under it. Never pad.
- This is a brief for continuing a task, not a summary of the conversation. Leave out greetings, repetition, plans that were replaced, and raw tool output.
- Leave out what the next session is given anyway: your standing instructions, project memory and CLAUDE.md contents, tool descriptions, and the environment or git status shown at the start of this session.
- Point to files, diffs, and tests by path, with a line number or function name where that helps. Do not copy their contents.
- Keep confirmed facts apart from assumptions, and label the assumptions.
- Never invent a test result, and never say a file was inspected unless it was read in this conversation.
- Never copy credentials, tokens, keys, or other secrets.
