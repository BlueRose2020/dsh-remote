# -*- coding: utf-8 -*-
"""
Debug driver for the WeChat bridge.

Spawns `bridge/wechat_bridge.py` and sends it commands, printing the replies.
Useful when the plugin is not running but you need to poke the bridge directly.

    python tools/drive.py '[{"id":1,"cmd":"status"}]'
    python tools/drive.py '[{"id":1,"cmd":"screenshot","maxWidth":1100}]'
    python tools/drive.py '[{"id":1,"cmd":"send","text":"#status"}]'
"""

import json
import os
import subprocess
import sys

# stdout is a pipe, so Windows would otherwise pick the ANSI code page and turn
# every Chinese reply into mojibake.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    bridge = os.path.join(here, "..", "bridge", "wechat_bridge.py")
    commands = json.loads(argv[1]) if len(argv) > 1 else [{"id": 1, "cmd": "status"}]

    proc = subprocess.Popen(
        [sys.executable, "-u", bridge],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    for command in commands:
        proc.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            print("!! bridge closed", file=sys.stderr)
            break
        try:
            print(json.dumps(json.loads(line), ensure_ascii=False, indent=2))
        except ValueError:
            print("RAW:", line)

    proc.stdin.write(json.dumps({"id": 999, "cmd": "shutdown"}) + "\n")
    proc.stdin.flush()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    stderr = proc.stderr.read()
    if stderr.strip():
        print("---- stderr ----", file=sys.stderr)
        print(stderr, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
