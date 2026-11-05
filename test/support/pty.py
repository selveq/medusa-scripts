#!/usr/bin/env python3
# runs a command on a real terminal and types the given lines as it asks: python3 pty.py '{"argv": [...], "lines": [...]}'
import json
import os
import pty
import select
import sys
import time

spec = json.loads(sys.argv[1])
lines = list(spec["lines"])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(spec["argv"][0], spec["argv"])

out = b""
deadline = time.time() + 60
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data
    # a prompt is output that stops without ending its line
    elif lines and out and not out.endswith(b"\n"):
        os.write(fd, lines.pop(0).encode() + b"\n")

sys.stdout.write(out.decode(errors="replace"))
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
