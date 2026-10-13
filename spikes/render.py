#!/usr/bin/env python3
"""M1 spike helper: replay captured terminal output onto a text grid.

Usage: render.py <raw-output-file> [cols] [rows] [byte-limit]

A deliberately small terminal emulator: cursor movement, erase, and scrolling
only. Colours and other attributes are ignored. Prints the final screen.
"""
import re
import sys

TOKEN = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC
    r"|\x1b\[([0-?]*)[ -/]*([@-~])"  # CSI
    r"|\x1b[()][0-9A-B]|\x1b[@-Z\\-_=>78]"  # other escapes
    r"|[\x00-\x1f]"  # control characters
    r"|[^\x00-\x1f\x1b]+",  # text
    re.S,
)


def render(data: str, cols: int, rows: int) -> list[str]:
    grid = [[" "] * cols for _ in range(rows)]
    r = c = 0

    def scroll() -> None:
        grid.pop(0)
        grid.append([" "] * cols)

    for m in TOKEN.finditer(data):
        tok = m.group(0)
        if m.group(2):
            params = [int(p) if p.isdigit() else 0 for p in m.group(1).split(";")] if m.group(1) else []
            n = (params[0] if params else 0) or 1
            final = m.group(2)
            if final in "Hf":
                r = min(rows - 1, max(0, (params[0] if params else 1) - 1))
                c = min(cols - 1, max(0, (params[1] if len(params) > 1 else 1) - 1))
            elif final == "A":
                r = max(0, r - n)
            elif final == "B":
                r = min(rows - 1, r + n)
            elif final == "C":
                c = min(cols - 1, c + n)
            elif final == "D":
                c = max(0, c - n)
            elif final == "G":
                c = min(cols - 1, n - 1)
            elif final == "d":
                r = min(rows - 1, n - 1)
            elif final == "E":
                r, c = min(rows - 1, r + n), 0
            elif final == "F":
                r, c = max(0, r - n), 0
            elif final == "J":
                mode = params[0] if params else 0
                if mode in (2, 3):
                    grid[:] = [[" "] * cols for _ in range(rows)]
                elif mode == 0:
                    grid[r][c:] = [" "] * (cols - c)
                    for rr in range(r + 1, rows):
                        grid[rr] = [" "] * cols
            elif final == "K":
                mode = params[0] if params else 0
                if mode == 0:
                    grid[r][c:] = [" "] * (cols - c)
                elif mode == 1:
                    grid[r][: c + 1] = [" "] * (c + 1)
                else:
                    grid[r] = [" "] * cols
        elif tok == "\r":
            c = 0
        elif tok == "\n":
            if r == rows - 1:
                scroll()
            else:
                r += 1
        elif tok == "\b":
            c = max(0, c - 1)
        elif tok[0] == "\x1b" or ord(tok[0]) < 32:
            continue
        else:
            for ch in tok:
                if c >= cols:
                    c = 0
                    if r == rows - 1:
                        scroll()
                    else:
                        r += 1
                grid[r][c] = ch
                c += 1
    return ["".join(row).rstrip() for row in grid]


if __name__ == "__main__":
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    rows = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    # optional 4th argument: replay only the first N bytes
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else None
    raw = open(sys.argv[1], "rb").read()[:limit].decode("utf-8", "replace")
    screen = render(raw, cols, rows)
    while screen and not screen[-1]:
        screen.pop()
    print("\n".join(screen))
