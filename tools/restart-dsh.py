# -*- coding: utf-8 -*-
"""
Restart the DSH web server so plugin code changes take effect.

Why this is needed: DSH hot-reloads the *profile patch* (so config changes
apply live), but Node's ESM registry caches modules by URL. Once the plugin
module has been imported, editing `lib/*.js` on disk does not change the
running instance — only a fresh process re-reads it.

This script stops the running `dsh web` and starts a new one detached, so it
survives the death of the process it was launched from.

    python tools/restart-dsh.py            # restart
    python tools/restart-dsh.py --dry-run  # just report what would happen
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time


def web_url() -> str:
    return os.environ.get("DSH_WEB_URL", "http://127.0.0.1:3080")


def port_of(url: str) -> int:
    match = re.search(r":(\d+)", url)
    return int(match.group(1)) if match else 3080


def listener_pids(port: int):
    """
    PIDs listening on `port`, via `netstat -ano`.

    Deliberately not PowerShell: `Get-CimInstance` and `-Command` quoting both
    proved unreliable when spawned from a script.
    """
    result = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace")
    pids = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        if parts[3].upper() != "LISTENING":
            continue
        if not parts[1].endswith(f":{port}"):
            continue
        try:
            pid = int(parts[4])
        except ValueError:
            continue
        if pid not in pids:
            pids.append(pid)
    return pids


def parent_map():
    """
    `{pid: parent_pid}` for every process, via Toolhelp32.

    Pure ctypes: no PowerShell (its quoting from a script proved unreliable) and
    no deprecated `wmic`.
    """
    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_char * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    TH32CS_SNAPPROCESS = 0x00000002
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == -1:
        return {}
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    mapping = {}
    try:
        if kernel32.Process32First(snapshot, ctypes.byref(entry)):
            while True:
                mapping[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
                if not kernel32.Process32Next(snapshot, ctypes.byref(entry)):
                    break
    finally:
        kernel32.CloseHandle(snapshot)
    return mapping


def ancestor_chain(pid: int, parents: dict) -> list:
    chain = []
    seen = set()
    while pid and pid not in seen:
        seen.add(pid)
        chain.append(pid)
        pid = parents.get(pid, 0)
    return chain


def image_name(pid: int) -> str:
    result = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace")
    first = (result.stdout or "").strip().splitlines()
    if not first:
        return ""
    return first[0].split(",")[0].strip('"')


def state_file() -> str:
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "storages", "remote-channel.json")


def server_cwd() -> str | None:
    """
    The directory DSH was launched from.

    Load-bearing: the server's `process.cwd()` becomes the sandbox's
    workspaceRoot and decides which workspace/session set the GUI groups under,
    so relaunching from a different directory quietly shows the user a different
    (near-empty) session list. The plugin records it in its state file; if that
    is missing we refuse to guess.
    """
    path = state_file()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            recorded = json.load(handle).get("serverCwd")
    except Exception:
        return None
    if isinstance(recorded, str) and recorded.strip() and os.path.isdir(recorded):
        return recorded
    return None


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--wait", type=float, default=30.0,
                        help="seconds to wait for the new server to answer")
    parser.add_argument("--cwd", default="",
                        help="directory to relaunch DSH from; defaults to the recorded server cwd")
    parser.add_argument("--force-cwd", action="store_true",
                        help="relaunch even when no server cwd can be determined")
    parser.add_argument("--port", type=int, default=0,
                        help="port to stop and relaunch on; defaults to the DSH_WEB_URL port. "
                             "Point this at a throwaway instance to rehearse the restart safely.")
    parser.add_argument("--tree", action="store_true",
                        help="also kill the server's child processes. Ignored (safely) when this "
                             "script is itself inside that tree.")
    parser.add_argument("--log", default="",
                        help="file to capture the new server's own output into. `dsh web` prints the "
                             "authenticated URL (it carries the browser token) on startup, and that "
                             "line is the only way to open or probe the UI without a live browser "
                             "session — with no --log it goes to DEVNULL.")
    args = parser.parse_args(argv[1:])

    url = web_url()
    if args.port:
        url = re.sub(r":\d+", f":{args.port}", url)
    port = args.port or port_of(url)

    cwd = args.cwd or server_cwd()
    if cwd is None and not args.force_cwd:
        print(f"cannot determine the directory DSH was started from ({state_file()} has no usable 'serverCwd').")
        print("Refusing to restart: a different working directory changes which workspace and sessions the")
        print("Web UI shows. Re-run with --cwd <dir> (or --force-cwd to accept the current directory).")
        return 3
    cwd = cwd or os.getcwd()
    print(f"will relaunch DSH from: {cwd}")
    print(f"port under test: {port}")

    pids = listener_pids(port)
    if not pids:
        print(f"nothing is listening on port {port}; starting a fresh server")

    parents = parent_map()
    my_chain = set(ancestor_chain(os.getpid(), parents))
    for pid in pids:
        name = image_name(pid)
        print(f"port {port} held by pid {pid} ({name or 'unknown'})")
        if name and name.lower() != "node.exe":
            print("  refusing to kill a non-node process")
            continue
        # `taskkill /T` walks the process tree. If this script was started from
        # inside the server (a tool call, an embedded terminal) then it — and
        # the relaunch it is about to perform — are IN that tree, so a tree kill
        # would leave the machine with no server at all. Killing just the
        # listener is enough: the server's own children exit when its pipes
        # close, and the plugin's Python bridge exits on stdin EOF.
        tree_kill = args.tree and pid not in my_chain
        if args.tree and pid in my_chain:
            print("  note: this script is running INSIDE that process tree; "
                  "using a plain kill so the relaunch survives")
        if args.dry_run:
            print(f"  dry run: would stop it ({'tree' if tree_kill else 'single process'})")
            continue
        command = ["taskkill", "/PID", str(pid), "/F"]
        if tree_kill:
            command.insert(2, "/T")
        subprocess.run(command, capture_output=True, text=True)

    if args.dry_run:
        print("dry run: not starting a replacement")
        return 0

    time.sleep(2)
    # Detached so the new server outlives this script.
    DETACHED_PROCESS = 0x00000008
    flags = DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    log_handle = None
    if args.log:
        directory = os.path.dirname(os.path.abspath(args.log))
        if directory:
            os.makedirs(directory, exist_ok=True)
        log_handle = open(args.log, "ab", buffering=0)
        out = log_handle
        err = subprocess.STDOUT
        print(f"capturing the new server's output into {args.log}")
    else:
        out = subprocess.DEVNULL
        err = subprocess.DEVNULL
    subprocess.Popen(["dsh", "web", "--port", str(port), "--no-open"], creationflags=flags, cwd=cwd,
                     stdout=out, stderr=err,
                     stdin=subprocess.DEVNULL, shell=True, close_fds=True)
    if log_handle is not None:
        # The child inherits the handle; the parent has no reason to hold it open.
        log_handle.close()
    print(f"started a new `dsh web` on port {port}; waiting for it to answer...")

    import urllib.error
    import urllib.request

    deadline = time.time() + args.wait
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status < 500:
                    print(f"OK — {url} answered with {response.status}")
                    return 0
        except urllib.error.HTTPError as error:
            # 401/403 still proves the server is listening; the web app requires a
            # token, so an unauthenticated probe is expected to be rejected.
            # Treating that as "not up yet" would report a false failure on a
            # restart that actually succeeded.
            print(f"OK — {url} answered with HTTP {error.code} (server is up)")
            return 0
        except Exception:
            time.sleep(1)
    print(f"WARNING: {url} did not answer within {args.wait}s; check the terminal")
    return 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main(sys.argv))
