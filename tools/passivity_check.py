# -*- coding: utf-8 -*-
"""
Verify that a background poll never touches the desktop.

The whole point of the `wechat-local` transport's read path is that it is
invisible: a person using the machine must not see the window change, the
keyboard focus move, or the mouse jump. This script asks the bridge for several
poll cycles and asserts that the foreground window and the cursor position are
byte-identical afterwards.

    python tools/passivity_check.py [--cycles 5]

Exit code 0 means passive; 1 means a poll changed something.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]


def snapshot_desktop():
    hwnd = user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    point = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(point))
    return {"foreground": int(hwnd), "title": buf.value, "cursor": (point.x, point.y)}


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=5)
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--close-chat-first", action="store_true",
                        help="close 文件传输助手 before polling and assert it stays closed")
    args = parser.parse_args(argv[1:])

    here = os.path.dirname(os.path.abspath(__file__))
    bridge = os.path.join(here, "..", "bridge", "wechat_bridge.py")

    proc = subprocess.Popen(
        [sys.executable, "-u", bridge],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    def send(payload):
        proc.stdin.write(json.dumps(payload) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())

    def chat_windows():
        sys.path.insert(0, os.path.join(here, "..", "bridge"))
        import wechat_bridge as wb

        return [w["title"] for w in wb.wechat_windows() if w["title"] == wb.CHAT_TITLE]

    try:
        send({"id": 0, "cmd": "ping"})

        if args.close_chat_first:
            send({"id": 100, "cmd": "reopen_chat"})          # make sure one exists
            time.sleep(1)
            # Close it through the same code path the bridge uses, from here, so
            # the poll under test really has nothing to read.
            sys.path.insert(0, os.path.join(here, "..", "bridge"))
            import wechat_bridge as wb

            removed = wb.WeChatBridge().close_chat_windows()
            print(f"closed {removed} 文件传输助手 window(s); remaining={chat_windows()}")
            if chat_windows():
                print("FAIL: could not close the chat window for the test")
                return 1

        baseline = snapshot_desktop()
        print(f"baseline: foreground={baseline['title']!r} cursor={baseline['cursor']}")

        drifts = []
        for cycle in range(1, args.cycles + 1):
            # Measure immediately around the request, not at interval
            # boundaries: a person using this machine moves the mouse on their
            # own, and comparing samples seconds apart blamed the poll for it.
            before = snapshot_desktop()
            response = send({"id": cycle, "cmd": "poll", "autoOpen": False})
            after = snapshot_desktop()
            result = response.get("result", {})
            status = "ok"
            if after != before:
                status = "DRIFT"
                drifts.append({"cycle": cycle, "before": before, "after": after})
            extra = f" skipped={result['skipped']}" if result.get("skipped") else ""
            print(f"poll {cycle}: visible={result.get('visible', '-')} "
                  f"new={len(result.get('messages', []))}{extra} -> {status}")
            time.sleep(args.interval)

        if drifts:
            print("\nFAIL: polling changed the desktop")
            for drift in drifts:
                print(f"  cycle {drift['cycle']}: {drift['before']} -> {drift['after']}")
            return 1

        if args.close_chat_first:
            reopened = chat_windows()
            if reopened:
                print(f"\nFAIL: passive polling re-opened the chat window: {reopened}")
                return 1
            print("\nPASS: polling left the closed chat window closed and touched nothing")

        print("\nPASS: polling never changed the foreground window or the cursor")
        return 0
    finally:
        try:
            send({"id": 999, "cmd": "shutdown"})
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main(sys.argv))
