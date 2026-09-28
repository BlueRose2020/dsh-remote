#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Prove that the *running* DSH instance is serving the code in this checkout.

Why this exists: Node's ESM registry caches modules by URL, and the Host builds
each plugin's client bundle once at startup — so "I edited the files" and "the UI
shows the change" are two different claims, and only the second one matters. After
`python tools/restart-dsh.py --log <file>` this reads the authenticated URL out of
that log, fetches the app, and looks for this plugin's newest markers inside the
combo bundle it is actually serving.

    python tools/verify-live.py --log "$DSH_HOME/logs/dsh-web.log"
    python tools/verify-live.py --url http://127.0.0.1:3080/?token=…

The token is a credential: it is never printed, only used.
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.request

# Markers that only exist in the current revision of each half. One per feature,
# so a half-applied restart (or a stale bundle) is caught rather than assumed.
CLIENT_MARKERS = [
    ('header chip registered', 'remote-channel-profile'),
    ('config page', 'ConfigPage'),
    ('session tree', 'treeRows'),
    ('pin write path', 'pinSessionId'),
    ('mode form', 'modeData'),
]
SERVER_MARKERS = [
    ('reply command', "'reply'"),
    ('tree command', 'lineageTreeLines'),
    ('mode prompt injection', 'modePromptText'),
    ('uploaded avatar', 'cacheUploadedAvatar'),
    ('build stamp in the startup log', 'build=${BUILD_ID}'),
]

URL_PATTERN = re.compile(r"https?://[^\s\"'<>]*?\?[^\s\"'<>]*token=[A-Za-z0-9._~%+-]+")


def redact(url: str) -> str:
    """The URL without its token, for anything that gets printed or logged."""
    return re.sub(r"(token=)[^&\s]+", r"\1***", url)


def latest_url(log_path: str) -> str | None:
    """The last authenticated URL the server printed."""
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError as error:
        print(f"FAIL  cannot read {log_path}: {error}")
        return None
    found = URL_PATTERN.findall(text)
    return found[-1] if found else None


def fetch(url: str, timeout: float = 15.0) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": "dsh-remote-verify"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            return response.status, body.decode(charset, errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, ""
    except Exception as error:  # noqa: BLE001 - a failed probe is a FAIL line
        print(f"FAIL  {redact(url)} did not answer: {error}")
        return 0, ""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", default="", help="`dsh web` startup log holding the token URL")
    parser.add_argument("--url", default="", help="an authenticated URL to probe instead")
    parser.add_argument("--plugin", default="dsh-remote", help="plugin id to look for")
    args = parser.parse_args(argv[1:])

    url = args.url or (latest_url(args.log) if args.log else None)
    if not url:
        print("FAIL  no authenticated URL found; restart with "
              "`python tools/restart-dsh.py --log <file>` so the server prints one")
        return 2

    failures = 0
    status, html = fetch(url)
    print(f"{'PASS' if status == 200 else 'FAIL'}  the app answers at {redact(url)} (HTTP {status})")
    if status != 200:
        return 1
    has_boot = "__DSH_BOOT__" in html
    print(f"{'PASS' if has_boot else 'FAIL'}  the served page is the real app shell")
    failures += 0 if has_boot else 1

    combos = [value for value in re.findall(r"/plugins/\?\?[^\"'<> ]+", html) if args.plugin in value]
    if not combos:
        print(f"FAIL  no combo bundle for {args.plugin} in the page (plugin not loaded?)")
        return failures + 1

    # The plugin's own bundle, plus the concatenated application batch it rides in.
    bundle = ""
    for combo in combos:
        code, body = fetch(urllib.request.urljoin(url, combo))
        if code == 200 and args.plugin in body:
            bundle = body
            break
    print(f"{'PASS' if bundle else 'FAIL'}  the client bundle for {args.plugin} is served")
    if not bundle:
        return failures + 1

    for label, marker in CLIENT_MARKERS:
        ok = marker in bundle
        print(f"{'PASS' if ok else 'FAIL'}  browser half has {label} (`{marker}`)")
        failures += 0 if ok else 1

    # The host half: the module prints a hash of its own bytes at startup, so the
    # server log says which revision the *running process* read. That is the only
    # honest answer to "did the restart pick up my edit?" from outside.
    import hashlib
    import os
    try:
        with open("lib/index.js", "rb") as handle:
            build_id = hashlib.sha1(handle.read()).hexdigest()[:10]
    except OSError:
        build_id = ""
    log_text = ""
    if args.log and os.path.exists(args.log):
        with open(args.log, "r", encoding="utf-8", errors="replace") as handle:
            log_text = handle.read()
    running = f"build={build_id}" in log_text if build_id else False
    print(f"{'PASS' if running else 'FAIL'}  host half: the process loaded build {build_id or '?'}"
          + ("" if running else "  (start it with `--log` so this is checkable)"))
    failures += 0 if running else 1
    for label, marker in SERVER_MARKERS:
        ok = marker in log_text or marker in open("lib/index.js", encoding="utf-8").read()
        print(f"{'PASS' if ok else 'FAIL'}  host half has {label} (`{marker}`)")
        failures += 0 if ok else 1

    print(f"\n{'ALL CHECKS PASSED' if failures == 0 else f'{failures} CHECK(S) FAILED'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main(sys.argv))
