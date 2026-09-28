#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Standalone desktop screenshot helper.

Deliberately independent of the WeChat transport: a report image is an output
artifact the agent attaches, so it must work on a QQ-only install too.

    python screenshot.py <out.png> [max_width] [window_title] [monitor]
    python screenshot.py --list            # monitors, machine-readable

Prints `<width>x<height>` of the saved image on stdout. Only Pillow is
required.

`max_width` <= 0 means **do not scale at all**: the capture is a BitBlt of the
real screen DC, so it is pixel-exact at the desktop's physical resolution, and
any downscale is what makes a screenshot of text look soft on a phone. When a
scale-down is asked for it uses LANCZOS, which keeps small glyphs readable far
better than the default filter.

`monitor` selects what is captured:

    primary | main | 主屏   just the main display (also the default)
    all | 全部             every screen side by side
    1, 2, 3 …              one display by its Windows number (see `--list`)

`--list` prints one line per display so callers can offer the numbers to a
human: `<index>|<device>|<width>x<height>|<primary|secondary>`.
"""

from __future__ import annotations

import ctypes
import sys


def _make_dpi_aware():
    """
    Ask Windows for real pixels instead of a stretched bitmap.

    Pillow's ImageGrab already does this on recent versions; calling it again is
    harmless (Windows refuses the second call) and it is what keeps a 150 %
    display from being captured at 2/3 resolution and then upscaled by the chat
    app into a blurry mess.
    """
    try:
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class _MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_ulong),
        ("rcMonitor", _RECT),
        ("rcWork", _RECT),
        ("dwFlags", ctypes.c_ulong),
        ("szDevice", ctypes.c_wchar * 32),
    ]


def list_monitors():
    """
    Every display, numbered the way Windows names them (`\\\\.\\DISPLAY1` …).

    The coordinates are physical pixels because the process is DPI aware, which
    is also the space `ImageGrab` grabs in — so the same rects can be used both
    to describe a monitor to a human and to crop it.
    """
    monitors = []

    def _callback(hmonitor, hdc, rect, data):
        info = _MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(_MONITORINFOEXW)
        if ctypes.windll.user32.GetMonitorInfoW(hmonitor, ctypes.byref(info)):
            area = info.rcMonitor
            monitors.append({
                "device": str(info.szDevice),
                "left": int(area.left),
                "top": int(area.top),
                "right": int(area.right),
                "bottom": int(area.bottom),
                "width": int(area.right - area.left),
                "height": int(area.bottom - area.top),
                "primary": bool(info.dwFlags & 1),  # MONITORINFOF_PRIMARY
            })
        return 1

    try:
        import ctypes

        callback = ctypes.WINFUNCTYPE(
            ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(_RECT), ctypes.c_double
        )(_callback)
        ctypes.windll.user32.EnumDisplayMonitors(None, None, callback, 0)
    except Exception:
        return []
    # Stable numbering: `\\.\DISPLAY1` before `\\.\DISPLAY2`, so a number a human
    # wrote down still means the same screen after a replug.
    monitors.sort(key=lambda item: item["device"])
    for position, monitor in enumerate(monitors, start=1):
        monitor["index"] = position
    return monitors


def describe_monitors(monitors):
    """Machine-readable listing consumed by `lib/desktop.js`."""
    return "\n".join(
        f"{m['index']}|{m['device']}|{m['width']}x{m['height']}|{'primary' if m['primary'] else 'secondary'}"
        for m in monitors
    )


def main(argv):
    if len(argv) < 2:
        print("usage: screenshot.py <out.png> [max_width] [window_title] [monitor]", file=sys.stderr)
        return 2
    # Before anything is measured: monitor rects are only physical pixels once the
    # process is DPI aware, otherwise a 150 % display reports 2/3 of its size.
    _make_dpi_aware()
    if argv[1] == "--list":
        print(describe_monitors(list_monitors()))
        return 0
    out = argv[1]
    # `0` (or a negative value) is a deliberate "no scaling", not a typo.
    max_width = int(argv[2]) if len(argv) > 2 and argv[2] else 0
    window_title = argv[3] if len(argv) > 3 and argv[3] else None
    monitor = (argv[4] if len(argv) > 4 and argv[4] else "primary").strip().lower()

    from PIL import Image, ImageGrab

    image = None
    if window_title:
        try:
            import uiautomation as auto

            auto.SetGlobalSearchTimeout(2.0)
            control = auto.WindowControl(searchDepth=1, SubName=window_title)
            if control.Exists(1):
                rect = control.BoundingRectangle
                if rect.width() > 80 and rect.height() > 80:
                    image = ImageGrab.grab(
                        bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True
                    ).convert("RGB")
        except Exception as exc:  # fall through to a full-desktop grab
            print(f"screenshot: window capture failed: {exc!r}", file=sys.stderr)

    if image is None:
        if monitor in ("all", "全部", "所有", "全屏"):
            image = ImageGrab.grab(all_screens=True).convert("RGB")
        elif monitor.isdigit():
            monitors = list_monitors()
            wanted = int(monitor)
            if wanted < 1 or wanted > len(monitors):
                names = ", ".join(f"{m['index']}={m['width']}x{m['height']}" for m in monitors) or "无"
                print(f"screenshot: 没有第 {wanted} 个显示器（可用：{names}）", file=sys.stderr)
                return 3
            chosen = monitors[wanted - 1]
            if chosen["primary"]:
                image = ImageGrab.grab(all_screens=False).convert("RGB")
            else:
                image = ImageGrab.grab(
                    bbox=(chosen["left"], chosen["top"], chosen["right"], chosen["bottom"]),
                    all_screens=True,
                ).convert("RGB")
        else:
            # `primary` / `main` / `主屏` / anything unrecognised: the main screen is
            # the useful default, never "all screens" (a two-monitor strip is the
            # least legible thing to put on a phone).
            image = ImageGrab.grab(all_screens=False).convert("RGB")

    if max_width and max_width > 0 and image.width > max_width:
        ratio = max_width / image.width
        image = image.resize(
            (max(1, int(image.width * ratio)), max(1, int(image.height * ratio))),
            Image.LANCZOS,
        )

    image.save(out, format="PNG", optimize=True)
    print(f"{image.width}x{image.height}")
    return 0


if __name__ == "__main__":
    import io

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main(sys.argv))
