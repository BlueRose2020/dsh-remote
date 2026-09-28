# -*- coding: utf-8 -*-
"""
Verify that an orphaned WeChat bridge cleans itself up.

`restart-dsh.py` kills only the DSH server process (a tree kill would also kill
the restart script itself when it is started from inside DSH). That is only safe
if the server's children exit on their own. The bridge's whole contract is
"read JSON lines from stdin until EOF", so when the server dies its stdin closes
and the bridge must exit — if it did not, every restart would leak a Python
process that keeps a handle on WeChat.

    python tools/bridge_orphan_check.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "bridge", "wechat_bridge.py")

failures = []


def check(label, condition, detail=""):
    if not condition:
        failures.append(label)
    print(f"{'PASS' if condition else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")


def main():
    process = subprocess.Popen(
        [sys.executable, "-u", BRIDGE],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", bufsize=1,
    )
    process.stdin.write('{"id":1,"cmd":"ping"}\n')
    process.stdin.flush()
    reply = process.stdout.readline().strip()
    check("bridge handshakes before the test", '"pong"' in reply, reply[:60])
    check("bridge is alive", process.poll() is None, f"pid={process.pid}")

    # The parent server dying closes the pipe; that is all the bridge should need.
    process.stdin.close()
    deadline = time.time() + 6
    while time.time() < deadline and process.poll() is None:
        time.sleep(0.25)

    exited = process.poll() is not None
    check("bridge exits on its own once stdin reaches EOF", exited,
          "still running — a restart would leak it" if not exited else f"exit={process.poll()}")
    if not exited:
        process.kill()

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED: {', '.join(failures)}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())
