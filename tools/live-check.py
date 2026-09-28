# -*- coding: utf-8 -*-
"""
Ask the *running* DSH instance which version of the plugin it loaded.

DSH hot-reloads the profile patch, but Node's ESM registry caches modules by
URL, so editing `lib/*.js` does not change a live instance. After a restart you
want to know whether the new code actually took over — this sends `#status` to
文件传输助手, reads the reply back with OCR, and reports which features the
reply proves are live.

    python tools/live-check.py [--wait 25]

Exit code 0 when the current (newest) code answers, 2 when an older build
answers, 1 when nothing answers.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "bridge", "wechat_bridge.py")

# Markers that only exist in the current build, with what each one proves.
#
# Matching is character-overlap based because OCR mangles glyphs ("会话状态"
# comes back as "会i 舌状态"), so requiring most of the characters is stable
# where exact matching is not.
#
# `source` names the reply the marker must appear in — a marker asserted against
# a reply that never contains it is a guaranteed false negative, which is worse
# than no probe at all: it sends you restarting DSH for nothing.
# `optional` markers depend on runtime state (a live session, an OneBot
# transport) and are reported without failing the check.
MARKERS = [
    ("工作目录", 4, "status", False, "status reports the working directory"),
    ("会话状态", 3, "status", False, "status reports the session's live state"),
    ("累计", 2, "status", False, "status reports the counters"),
    ("clear", 5, "help", False, "help lists #clear"),
    ("工作区", 3, "help", False, "help lists the workspace commands"),
    ("可发指令者", 4, "status", True, "status reports the OneBot allowlist (onebot only)"),
]


def matches(text: str, marker: str, needed: int) -> bool:
    """Whether `text` contains most of `marker`'s characters, ignoring spacing."""
    compact = "".join(text.split())
    return sum(1 for ch in marker if ch in compact) >= needed


def run_commands(commands, timeout=180):
    proc = subprocess.Popen(
        [sys.executable, "-u", BRIDGE],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    replies = []
    try:
        for command in commands:
            proc.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                break
            replies.append(json.loads(line))
    finally:
        try:
            proc.stdin.write(json.dumps({"id": 999, "cmd": "shutdown"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    return replies


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait", type=float, default=25.0,
                        help="seconds to wait for the plugin to answer")
    args = parser.parse_args(argv[1:])

    sent = run_commands([
        {"id": 1, "cmd": "send", "text": "#status"},
        {"id": 2, "cmd": "send", "text": "#help"},
    ])
    if not sent or not sent[0].get("ok"):
        print(f"could not send the probe: {json.dumps(sent, ensure_ascii=False)[:300]}")
        return 1
    print("#status / #help sent; waiting for the plugin to answer...")

    time.sleep(args.wait)
    snapshot = run_commands([{"id": 1, "cmd": "snapshot"}])
    messages = (snapshot[0].get("result", {}) if snapshot else {}).get("messages", [])
    texts = [m.get("text", "") for m in messages]

    status_reply = next((t for t in reversed(texts) if "DSH" in t and "状态" in t), None)
    if status_reply is None:
        print("no [DSH 状态] reply seen — is the plugin running and logged in?")
        return 1
    # The help reply is the one that is not the status reply but mentions DSH.
    help_reply = next((t for t in reversed(texts) if "DSH" in t and "远程指令" in t), "")

    print("\n--- newest status reply ---")
    print(status_reply)
    if help_reply:
        print("\n--- newest help reply ---")
        print(help_reply)
    print("----------------------------\n")

    by_source = {"status": status_reply, "help": help_reply}
    missing = []
    for marker, needed, source, optional, label in MARKERS:
        text = by_source.get(source, "")
        found = bool(text) and matches(text, marker, needed)
        if not found and not optional:
            missing.append(label)
        note = " (optional)" if optional else ""
        print(f"  {'yes' if found else 'NO ':>3}  {label}{note}")

    if not missing:
        print("\nCURRENT BUILD is live.")
        return 0
    if not help_reply:
        print("\nINCONCLUSIVE: no #help reply arrived, so the help-based markers were not exercised.")
        print("(This is a probe limitation, not proof of an old build.)")
        return 1
    print(f"\nOLDER BUILD is live (missing {len(missing)} marker(s)): {', '.join(missing)}")
    print("Restart DSH to load lib/*.js changes: python tools/restart-dsh.py")
    return 2


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main(sys.argv))
