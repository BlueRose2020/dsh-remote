#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Checks for the card renderer's path handling.

Paths are the one thing every remote card is full of and the one thing a wrapper can
ruin: `D:\\tool\\programming\\DSH\\test\\archive-2026\\branch` used to be drawn in the
body font, pushed into a right-hand column, and finally chopped into
`archive-2026\\branc` + `h`. These assertions are about *that* — elision keeps the
volume and the project name, runs are split so a path is monospace, and a wrap may
only break at a separator.

    python tools/path_check.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge"))

import text_image as t  # noqa: E402

failures = []


def check(label: str, condition: bool, detail: str = "") -> None:
    mark = "PASS" if condition else "FAIL"
    if not condition:
        failures.append(label)
    sys.stderr.write(f"{mark}  {label}{f' — {detail}' if detail else ''}\n")


def path_run_index(runs):
    return [index for index, (_, kind) in enumerate(runs) if kind == "p"]


def main() -> int:
    # --- elision keeps the volume and the last two segments -------------------
    short = r"D:\tool\programming\DSH\秋招"
    check("a path that already fits is untouched", t.elide_path(short) == short, t.elide_path(short))

    long_path = r"D:\tool\programming\DSH\test\archive-2026\branch"
    elided = t.elide_path(long_path)
    check("a long path is elided in the middle", "…" in elided and len(elided) <= 44, elided)
    check("elision keeps the volume", elided.startswith("D:\\"), elided)
    check("elision keeps the two segments that identify the project",
        elided.endswith(r"archive-2026\branch"), elided)

    deep = r"C:\a\b\c\d\e\f\g\h\i\j\k\l\m\n\o\p"
    deepest = t.elide_path(deep)
    check("even a path of many tiny segments stays within the limit",
        len(deepest) <= 44 and deepest.startswith("C:\\"), deepest)

    posix = "/home/user/projects/very-long-name/another/deep/one"
    check("a POSIX path elides too", "…" in t.elide_path(posix) and len(t.elide_path(posix)) <= 44,
        t.elide_path(posix))

    os.environ["DSH_IMAGE_PATH_MAX"] = "0"
    check("DSH_IMAGE_PATH_MAX=0 disables eliding", t.elide_path(long_path) == long_path,
        t.elide_path(long_path))
    os.environ.pop("DSH_IMAGE_PATH_MAX")

    # --- a path becomes its own run, so it can get the monospace face ---------
    runs = t.parse_inline(r"工作区：D:\tool\programming\DSH\test\archive-2026\branch")
    kinds = [kind for _, kind in runs]
    check("a path inside a line becomes a path run", "p" in kinds, str(runs))
    check("the rest of the line stays ordinary text", kinds.count("n") >= 1, str(kinds))
    check("the path run is the elided one",
        any(text.startswith("D:\\") and "…" in text for text, kind in runs if kind == "p"), str(runs))

    check("a `#command` is still a command, not a path",
        [kind for _, kind in t.parse_inline("#status D:\\tool")] == ["k", "n", "p"],
        str(t.parse_inline("#status D:\\tool")))
    check("a URL fragment is not mistaken for a path",
        "p" not in [kind for _, kind in t.parse_inline("see https://example.com/a/b for that")],
        str(t.parse_inline("see https://example.com/a/b for that")))

    # --- breaking: only between separators ------------------------------------
    check("a path is one unbreakable unit per segment",
        [text for text, _ in t.run_units(r"D:\tool\programming", "p")] == ["D:", "\\tool", "\\programming"],
        str(t.run_units(r"D:\tool\programming", "p")))
    check("ordinary text still breaks per character",
        [text for text, _ in t.run_units("abc", "n")] == ["a", "b", "c"],
        str(t.run_units("abc", "n")))

    sys.stderr.write(f"\n{'ALL CHECKS PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED: ' + ', '.join(failures)}\n")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
