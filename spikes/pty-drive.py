#!/usr/bin/env python3
"""M1 spike helper: drive an interactive program through a pseudo-terminal.

Usage: pty-drive.py <steps.json> <raw-output-file> -- <command> [args...]

steps.json is a list of steps, run in order:
  {"wait": "<regex>", "timeout": 30}   wait until the regex matches new output
  {"send": "<text>"}                   type text (use \\r for Enter)
  {"sleep": 1.5}                       keep reading output for N seconds
  {"exit": true, "timeout": 20}        wait for the program to exit
  {"signal": "INT"}                    send a signal to the program

Regexes are matched against output with terminal escape sequences removed.
Prints a JSON summary: which steps passed, the exit status, and the terminal
modes before and after (to check they were restored).
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ANSI = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b[()][0-9A-B]")


def clean(data: bytes) -> str:
    return ANSI.sub(b"", data).decode("utf-8", "replace")


def main() -> None:
    sep = sys.argv.index("--")
    steps_path, raw_path = sys.argv[1:sep]
    command = sys.argv[sep + 1 :]
    steps = json.load(open(steps_path))
    cols = int(os.environ.get("SPIKE_COLS", "120"))
    rows = int(os.environ.get("SPIKE_ROWS", "40"))

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    modes_before = termios.tcgetattr(fd)

    raw = open(raw_path, "wb")
    buffer = b""
    mark = 0
    status = None
    results = []

    def pump(seconds: float) -> None:
        nonlocal buffer, status
        end = time.time() + seconds
        while time.time() < end and status is None:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    buffer += chunk
                    raw.write(chunk)
                    raw.flush()
                    continue
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st

    for step in steps:
        ok = True
        if "wait" in step:
            pattern = re.compile(step["wait"])
            deadline = time.time() + step.get("timeout", 30)
            ok = False
            while time.time() < deadline and status is None:
                pump(0.2)
                if pattern.search(clean(buffer[mark:])):
                    ok = True
                    break
            mark = len(buffer)
        elif "send" in step:
            os.write(fd, step["send"].encode())
        elif "sleep" in step:
            pump(step["sleep"])
        elif "signal" in step:
            os.kill(pid, getattr(signal, "SIG" + step["signal"]))
        elif "exit" in step:
            pump_until = time.time() + step.get("timeout", 20)
            while time.time() < pump_until and status is None:
                pump(0.2)
            ok = status is not None
        # offset lets render.py replay the screen as it stood after this step
        results.append({"step": step, "ok": ok, "offset": len(buffer)})
        if not ok and step.get("required", True):
            break

    try:
        modes_after = termios.tcgetattr(fd)
    except termios.error:
        modes_after = None
    if status is None:
        os.kill(pid, signal.SIGTERM)
        pump(3)
        if status is None:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    raw.close()

    summary = {
        "steps": results,
        "exit_code": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
        "term_signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
        "modes_restored": None if modes_after is None else modes_before[:4] == modes_after[:4],
        "bytes": len(buffer),
    }
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
