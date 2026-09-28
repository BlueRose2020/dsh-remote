# -*- coding: utf-8 -*-
"""
WeChat (Weixin 4.x) bridge for the DSH `remote-channel` plugin.

Speaks newline-delimited JSON on stdin/stdout. Every request carries an `id`
and every reply echoes it:

    -> {"id": 1, "cmd": "status"}
    <- {"id": 1, "ok": true, "result": {...}}

Commands
--------
  ping                          liveness
  status                        WeChat process / login / chat-window detection
  open_chat                     make sure the 文件传输助手 chat window is usable
  send    {text}                send one text message to 文件传输助手
  poll                          messages newer than the previous poll
  snapshot                      every message currently visible
  reset                         forget the poll cursor
  shutdown                      exit

Design notes
------------
WeChat 4.x renders its whole UI into a custom surface (`MMUIRenderSubWindowHW`)
and exposes **no** usable UI Automation tree, so this bridge uses:

  * sending  : clipboard + focus + Ctrl+V + Enter (WeChat's own paste path)
  * reading  : PrintWindow(PW_RENDERFULLCONTENT) -- works even when the window
               is occluded -- then Windows OCR (Windows.Media.Ocr, zh-Hans-CN)
  * in/out   : bubble background colour sampled from the captured pixels
               (outgoing bubbles are WeChat green, incoming ones are white/grey)

Only the standard library plus `winsdk` (Windows OCR), `pillow`, `uiautomation`
and `pywin32` are used.
"""

from __future__ import annotations

import asyncio
import ctypes
import difflib
import hashlib
import io
import json
import os
import re
import sys
import time
import traceback
from ctypes import wintypes

# ---------------------------------------------------------------- stdio setup
# stdout is the protocol channel: nothing but JSON may ever reach it.
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

try:
    # Windows gives pipes the ANSI code page (cp936 here) unless told otherwise.
    # stdin carries the UTF-8 JSON from Node, so all three streams must agree on
    # UTF-8 or Chinese text silently turns into mojibake.
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    _REAL_STDOUT.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - very old/odd streams
    pass

import win32api
import win32clipboard as clip
import win32con
import win32gui
import win32process
import uiautomation as auto
from PIL import Image, ImageGrab

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

# ------------------------------------------------------------------- win32 ffi
user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM),
                               wintypes.LPARAM]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetWindowDC.restype = wintypes.HDC
user32.GetWindowDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
kernel32.GetCurrentThreadId.restype = wintypes.DWORD

gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]

SW_RESTORE, SW_SHOW, SW_MINIMIZE, SW_SHOWNORMAL = 9, 5, 6, 1
WM_CLOSE = 0x0010
HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x1, 0x2, 0x40
PW_RENDERFULLCONTENT = 0x00000002

CHAT_TITLE = "文件传输助手"
MAIN_TITLE = "微信"
WECHAT_CLASS = "Qt51514QWindowIcon"
WECHAT_EXES = ("weixin.exe", "wechat.exe")

_log = lambda *a: print("[wechat-bridge]", *a, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ utilities
def _window_text(hwnd) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 2)
    user32.GetWindowTextW(hwnd, buf, n + 2)
    return buf.value


def _class_name(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(512)
    user32.GetClassNameW(hwnd, buf, 512)
    return buf.value


def _rect(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom)


def _pid_of(hwnd) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def enum_top_windows():
    """All top-level windows as dicts (hwnd, pid, exe, cls, title, rect, visible)."""
    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        try:
            rect = _rect(hwnd)
            out.append({
                "hwnd": int(hwnd),
                "pid": _pid_of(hwnd),
                "cls": _class_name(hwnd),
                "title": _window_text(hwnd),
                "rect": list(rect),
                "visible": bool(user32.IsWindowVisible(hwnd)),
            })
        except Exception:
            pass
        return True

    user32.EnumWindows(_cb, 0)
    return out


def _process_exe(pid: int) -> str:
    try:
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(len(buf))
            if ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return os.path.basename(buf.value)
        finally:
            ctypes.windll.kernel32.CloseHandle(h)
    except Exception:
        pass
    return ""


def wechat_windows():
    """Top-level windows owned by a WeChat process, newest-first stable order."""
    wins = enum_top_windows()
    by_pid = {}
    for w in wins:
        by_pid.setdefault(w["pid"], []).append(w)
    result = []
    for pid, ws in by_pid.items():
        exe = _process_exe(pid).lower()
        if exe in WECHAT_EXES:
            for w in ws:
                w["exe"] = exe
                result.append(w)
    return result


def _is_alive(hwnd) -> bool:
    return bool(user32.IsWindow(hwnd))


# ------------------------------------------------------------------ capturing
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                            ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
gdi32.GetDIBits.restype = ctypes.c_int


def _is_blank(img: Image.Image, samples: int = 3000, max_colours: int = 8) -> bool:
    """Whether a capture carries no real content (a just-shown window's surface)."""
    raw = img.tobytes()
    total = len(raw) // 3
    if total == 0:
        return True
    step = max(1, total // samples) * 3
    seen = set()
    for i in range(0, len(raw) - 2, step):
        seen.add((raw[i], raw[i + 1], raw[i + 2]))
        if len(seen) > max_colours:
            return False
    return True


def _screen_grab(hwnd) -> Image.Image:
    """Screen capture of the window rect; only valid while it is unoccluded."""
    left, top, right, bottom = _rect(hwnd)
    return ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True).convert("RGB")


def capture_window(hwnd, retries: int = 2) -> Image.Image:
    """
    Capture a window's full rect.

    `PrintWindow(PW_RENDERFULLCONTENT)` is preferred because it also works while
    the window is occluded — but a window that has *just* been shown returns an
    empty surface, so a blank result is retried and finally falls back to a
    plain screen grab (by then the window is foreground and unoccluded).
    """
    img = _print_window(hwnd)
    if not _is_blank(img):
        return img
    for _ in range(max(0, retries)):
        time.sleep(0.5)
        img = _print_window(hwnd)
        if not _is_blank(img):
            return img
    try:
        grabbed = _screen_grab(hwnd)
        if not _is_blank(grabbed):
            return grabbed
    except Exception as exc:  # pragma: no cover - headless/odd sessions
        _log("screen fallback failed:", repr(exc))
    return img


def _print_window(hwnd) -> Image.Image:
    left, top, right, bottom = _rect(hwnd)
    w, h = max(1, right - left), max(1, bottom - top)
    hdc = user32.GetWindowDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    old = gdi32.SelectObject(mdc, bmp)
    try:
        user32.PrintWindow(hwnd, mdc, PW_RENDERFULLCONTENT)
        bi = BITMAPINFO()
        bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.bmiHeader.biWidth = w
        bi.bmiHeader.biHeight = -h  # top-down
        bi.bmiHeader.biPlanes = 1
        bi.bmiHeader.biBitCount = 32
        buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
        return Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    finally:
        gdi32.SelectObject(mdc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mdc)
        user32.ReleaseDC(hwnd, hdc)


# ------------------------------------------------------------------ ocr layer
_OCR_ENGINE = None
_OCR_LANG = os.environ.get("DSH_WECHAT_OCR_LANG", "zh-Hans-CN")
_OCR_SCALE = float(os.environ.get("DSH_WECHAT_OCR_SCALE", "2"))


async def _ocr_engine():
    global _OCR_ENGINE
    if _OCR_ENGINE is not None:
        return _OCR_ENGINE
    from winsdk.windows.media.ocr import OcrEngine
    from winsdk.windows.globalization import Language

    engine = OcrEngine.try_create_from_language(Language(_OCR_LANG))
    if engine is None:
        tags = [l.language_tag for l in OcrEngine.available_recognizer_languages]
        raise RuntimeError(
            f"Windows OCR language {_OCR_LANG!r} is unavailable; installed: {tags}. "
            f"Install it via Settings > Time & language > Language & region > 中文(简体) > 可选语言功能 > 光学字符识别."
        )
    _OCR_ENGINE = engine
    return engine


async def ocr_image(img: Image.Image):
    """Run Windows OCR; returns [(text, x, y, w, h)] in original image pixels."""
    import tempfile
    from winsdk.windows.storage import StorageFile, FileAccessMode
    from winsdk.windows.graphics.imaging import BitmapDecoder

    engine = await _ocr_engine()
    scaled = img
    if _OCR_SCALE and _OCR_SCALE != 1:
        scaled = img.resize((int(img.width * _OCR_SCALE), int(img.height * _OCR_SCALE)),
                            Image.LANCZOS)
    fd, path = tempfile.mkstemp(suffix=".png", prefix="dsh-wechat-ocr-")
    os.close(fd)
    try:
        scaled.save(path)
        f = await StorageFile.get_file_from_path_async(path)
        stream = await f.open_async(FileAccessMode.READ)
        decoder = await BitmapDecoder.create_async(stream)
        bmp = await decoder.get_software_bitmap_async()
        res = await engine.recognize_async(bmp)
        lines = []
        for line in res.lines:
            words = list(line.words)
            if not words:
                continue
            xs = [w.bounding_rect.x for w in words]
            ys = [w.bounding_rect.y for w in words]
            xe = [w.bounding_rect.x + w.bounding_rect.width for w in words]
            ye = [w.bounding_rect.y + w.bounding_rect.height for w in words]
            lines.append((
                line.text,
                min(xs) / _OCR_SCALE, min(ys) / _OCR_SCALE,
                (max(xe) - min(xs)) / _OCR_SCALE, (max(ye) - min(ys)) / _OCR_SCALE,
            ))
        return lines
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# ------------------------------------------------------- message reconstruct--
_CJK = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]")


def normalize(text: str) -> str:
    """Collapse the inter-character spaces Windows OCR inserts in CJK runs."""
    text = text.replace("\u00a0", " ").strip()
    out = []
    for ch in text:
        if ch == " " and out and _CJK.match(out[-1]):
            continue
        if ch == " " and out and _CJK.match(ch):
            continue
        out.append(ch)
    return "".join(out).strip()


_NOISE_PATTERNS = (
    re.compile(r"^[\s\d:：./、，,+\-—]+$"),                       # bare timestamps / counters
    re.compile(r"^(星期|周|昨天|今天|凌晨|上午|下午|晚上|中午)[\s\d:：年月日]*$"),
    re.compile(r"^\d{1,2}\s*[：:]\s*\d{1,2}$"),
    re.compile(r"^(微信电脑版|微信手机版|以下为新消息|查看更多消息|已读|未读)$"),
)


def _is_noise(text: str) -> bool:
    t = normalize(text)
    if not t:
        return True
    if len(t) <= 1 and not _CJK.match(t):
        return True
    for marker in ("语音输入文字", "按住鼠标", "按住 说话"):
        if marker in t:
            return True
    if t in ("发送", "发送(S)", "Send", "Enter"):
        return True
    for pat in _NOISE_PATTERNS:
        if pat.match(t):
            return True
    return False


def _similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def classify_background(img: Image.Image, x, y, w, h):
    """Dominant bubble colour in a band around a text line -> 'in' | 'out'."""
    y0 = max(0, int(y - h * 0.9))
    y1 = min(img.height, int(y + h * 1.9))
    x0 = max(0, int(x - 24))
    x1 = min(img.width, int(x + w + 24))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return "in", None
    band = img.crop((x0, y0, x1, y1))
    raw = band.tobytes()  # RGB, 3 bytes per pixel
    counts = {}
    total = 0
    for i in range(0, len(raw) - 2, 3):
        p = (raw[i], raw[i + 1], raw[i + 2])
        if p[0] + p[1] + p[2] <= 240:  # drop dark text pixels
            continue
        counts[p] = counts.get(p, 0) + 1
        total += 1
    if not counts:
        return "in", None
    dom, n = max(counts.items(), key=lambda kv: kv[1])
    r, g, b = dom
    # WeChat outgoing bubble is a saturated green; incoming is white / light grey.
    if g > r + 12 and g > b + 20 and g > 140:
        return "out", dom
    return "in", dom


def _message_area(img: Image.Image, mode: str):
    """Crop the scrollable message list out of a captured window."""
    w, h = img.size
    if mode == "detached":
        top = int(h * 0.105)
        bottom = int(h * 0.705)
        left = 0
    else:  # main window: session list on the left, chat panel on the right
        top = int(h * 0.13)
        bottom = int(h * 0.72)
        left = int(w * 0.26)
    return (max(0, left), max(0, top), w, max(top + 1, min(h, bottom)))


def build_messages(lines, img, mode):
    """Group OCR lines into messages, ordered top -> bottom."""
    area = _message_area(img, mode)
    cropped = img.crop(area)
    items = []
    for text, x, y, w, h in lines:
        if y < area[1] or y > area[3] or x < area[0]:
            continue
        t = normalize(text)
        if _is_noise(t):
            continue
        direction, colour = classify_background(cropped, x - area[0], y - area[1], w, h)
        items.append({"text": t, "x": x, "y": y, "w": w, "h": h,
                      "dir": direction, "colour": colour})
    items.sort(key=lambda i: i["y"])

    messages = []
    current = None
    for it in items:
        if current is not None and it["dir"] == current["dir"] and \
                it["y"] - current["last_y"] <= max(14.0, it["h"] * 1.9):
            current["lines"].append(it["text"])
            current["last_y"] = it["y"]
            current["bottom"] = it["y"] + it["h"]
        else:
            if current is not None:
                messages.append(current)
            current = {"dir": it["dir"], "lines": [it["text"]],
                       "top": it["y"], "last_y": it["y"], "bottom": it["y"] + it["h"],
                       "x": it["x"], "w": it["w"]}
    if current is not None:
        messages.append(current)

    out = []
    for m in messages:
        text = "\n".join(m["lines"]).strip()
        if not text:
            continue
        out.append({
            "dir": m["dir"],
            "text": text,
            "top": round(m["top"], 1),
            "x": round(m["x"], 1),
            "fp": hashlib.sha1((m["dir"] + "\x00" + text).encode("utf-8")).hexdigest()[:16],
        })
    return out


def diff_new(prev, cur):
    """Messages appended since the previous snapshot (identical texts included)."""
    if not prev or not cur:
        return []
    kp = [m["fp"] for m in prev]
    kc = [m["fp"] for m in cur]
    best_end = -1
    for k in range(min(len(kp), len(kc)), 0, -1):
        tail = kp[len(kp) - k:]
        for i in range(len(kc) - k, -1, -1):
            if kc[i:i + k] == tail:
                best_end = max(best_end, i + k)
                break
        if best_end >= 0:
            break
    if best_end < 0:
        return []
    return cur[best_end:]


# ---------------------------------------------------------------- interaction
def ensure_visible(hwnd) -> bool:
    """
    Bring a window back from WeChat's tray-hide state.

    WeChat 4.x hides a window either by parking it at (-32000, -32000) or by
    clearing WS_VISIBLE, so `IsWindowVisible` alone is not enough. Returns True
    when the window had to be revealed — the caller then knows the message list
    may have jumped back to the top and needs re-anchoring.
    """
    if not _is_alive(hwnd):
        return False
    left, top, right, bottom = _rect(hwnd)
    parked = left <= -30000 or top <= -30000 or (right - left) < 200 or (bottom - top) < 200
    hidden = not user32.IsWindowVisible(hwnd)
    if parked or user32.IsIconic(hwnd) or hidden:
        user32.ShowWindow(hwnd, SW_SHOWNORMAL)
        time.sleep(0.5)
        return True
    return False


def scroll_to_bottom(hwnd, mode):
    """
    Wheel the message list down to its newest entry.

    A window that was hidden and is shown again renders its scrollback at the
    top, so the newest messages — the only ones that matter for a poll — would
    otherwise be off-screen. WM_MOUSEWHEEL goes to the window under the cursor,
    so this needs no focus; the cursor is saved and restored.
    """
    if not _is_alive(hwnd):
        return
    point = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(point))
    saved = (point.x, point.y)
    try:
        left, top, right, bottom = _rect(hwnd)
        w, h = right - left, bottom - top
        cx = left + w * (0.5 if mode == "detached" else 0.62)
        cy = top + h * 0.40
        user32.SetCursorPos(int(cx), int(cy))
        time.sleep(0.2)
        for _ in range(30):
            win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL, 0, 0, -120, 0)
            time.sleep(0.02)
        time.sleep(0.4)
    finally:
        try:
            user32.SetCursorPos(saved[0], saved[1])
        except Exception:
            pass


def click_at(x, y, double=False):
    """
    Synthetic click at absolute screen coordinates.

    Deliberately uses `SetCursorPos` plus *relative* `mouse_event` rather than
    uiautomation's `Click`, whose absolute form normalizes against the primary
    monitor only and therefore drifts on multi-monitor desktops.
    """
    user32.SetCursorPos(int(round(x)), int(round(y)))
    time.sleep(0.18)
    loops = 2 if double else 1
    for _ in range(loops):
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.05)
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        if double:
            time.sleep(0.09)
    time.sleep(0.2)


def force_foreground(hwnd) -> bool:
    """Best-effort activation; returns whether `hwnd` ended up foreground."""
    if not _is_alive(hwnd):
        return False
    ensure_visible(hwnd)
    if user32.GetForegroundWindow() == hwnd:
        return True
    fg = user32.GetForegroundWindow()
    tid_fg = user32.GetWindowThreadProcessId(fg, None)
    tid_me = kernel32.GetCurrentThreadId()
    try:
        user32.AttachThreadInput(tid_me, tid_fg, True)
        user32.BringWindowToTop(hwnd)
        user32.ShowWindow(hwnd, SW_SHOW)
        user32.SetForegroundWindow(hwnd)
    finally:
        user32.AttachThreadInput(tid_me, tid_fg, False)
    if user32.GetForegroundWindow() == hwnd:
        return True
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                        SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                        SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    time.sleep(0.25)
    return user32.GetForegroundWindow() == hwnd


def _read_clipboard():
    for _ in range(10):
        try:
            clip.OpenClipboard()
            try:
                if clip.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                    return clip.GetClipboardData(win32con.CF_UNICODETEXT)
                return ""
            finally:
                clip.CloseClipboard()
        except Exception:
            time.sleep(0.15)
    return ""


def _write_clipboard(text: str):
    clip.OpenClipboard()
    try:
        clip.EmptyClipboard()
        clip.SetClipboardData(win32con.CF_UNICODETEXT, text)
    finally:
        clip.CloseClipboard()


def _has_clipboard_sequence():
    try:
        clip.OpenClipboard()
        try:
            return bool(clip.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT))
        finally:
            clip.CloseClipboard()
    except Exception:
        return False


# ------------------------------------------------------------------ screenshots
def grab_screen(max_width: int = 0, window_title: str | None = None) -> Image.Image:
    """
    Capture the desktop (or one window) for chat delivery.

    `max_width <= 0` (the default) means **no scaling**: the grab is a BitBlt of
    the real screen DC, so it is pixel-exact, and any downscale is exactly what
    makes a screenshot of text look soft once a phone renders it. Pass a positive
    width only when payload size matters more than legibility.
    """
    if window_title:
        matches = [w for w in enum_top_windows() if window_title.lower() in w["title"].lower()]
        matches = [w for w in matches if (w["rect"][2] - w["rect"][0]) > 80]
        if matches:
            hwnd = matches[0]["hwnd"]
            ensure_visible(hwnd)
            img = capture_window(hwnd)
        else:
            img = ImageGrab.grab(all_screens=True).convert("RGB")
    else:
        img = ImageGrab.grab(all_screens=True).convert("RGB")
    if max_width and max_width > 0 and img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)
    return img


def image_to_png_base64(img: Image.Image) -> str:
    import base64
    buffer = io.BytesIO()
    img.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def copy_image_to_clipboard(img: Image.Image):
    """Put an image on the clipboard in the CF_DIB form WeChat's paste expects."""
    buffer = io.BytesIO()
    img.convert("RGB").save(buffer, format="BMP")
    dib = buffer.getvalue()[14:]  # drop the 14-byte BITMAPFILEHEADER
    buffer.close()
    clip.OpenClipboard()
    try:
        clip.EmptyClipboard()
        clip.SetClipboardData(win32con.CF_DIB, dib)
    finally:
        clip.CloseClipboard()


# ------------------------------------------------------------------- service
class WeChatBridge:
    def __init__(self):
        self.chat_hwnd = None
        self.chat_mode = None      # 'detached' | 'main'
        self.prev = []
        self.primed = False
        self.sent_texts = []       # our own outgoing texts, newest last
        self.last_status = None

    # -- window discovery ---------------------------------------------------
    def chat_candidates(self):
        wins = wechat_windows()
        detached, main, other = [], [], []
        for w in wins:
            l, t, r, b = w["rect"]
            w["w"], w["h"] = r - l, b - t
            if w["cls"] != WECHAT_CLASS:
                continue
            if w["title"] == CHAT_TITLE and w["visible"] and w["w"] > 300 and w["h"] > 300:
                detached.append(w)
            elif w["title"] == MAIN_TITLE:
                main.append(w)
            else:
                other.append(w)
        return detached, main, other, wins

    def pick_chat(self, force=False):
        if not force and self.chat_hwnd and _is_alive(self.chat_hwnd):
            return self.chat_hwnd, self.chat_mode
        detached, main, _other, _all = self.chat_candidates()
        # A detached 文件传输助手 window is the reliable surface: its title is
        # authoritative, where the main window needs OCR to prove which chat is
        # on screen. WeChat leaves it hidden rather than destroyed when closed,
        # so a hidden one is revealed and reused.
        usable = [w for w in detached if w["visible"] and w["w"] > 300 and w["h"] > 300]
        usable.sort(key=lambda w: -w["w"] * w["h"])
        if usable:
            # Only a *visible* detached window is trusted. WeChat parks a closed
            # one off-screen without destroying it, and re-showing it later
            # renders a stale, top-anchored page of the history — a freshly
            # opened window is the only one guaranteed to sit at the newest
            # message. Revealing is therefore left to open_chat().
            self.chat_hwnd, self.chat_mode = usable[0]["hwnd"], "detached"
            return self.chat_hwnd, self.chat_mode
        big_main = [w for w in main if w["w"] >= 500 and w["h"] >= 380]
        if big_main:
            big_main.sort(key=lambda w: -w["w"] * w["h"])
            self.chat_hwnd, self.chat_mode = big_main[0]["hwnd"], "main"
            return self.chat_hwnd, self.chat_mode
        self.chat_hwnd, self.chat_mode = None, None
        return None, None

    # -- status -------------------------------------------------------------
    @staticmethod
    def _loose_contains(blob: str, needle: str, min_hits: int = 4) -> bool:
        """Tolerate a couple of OCR errors when matching a known caption."""
        return sum(1 for ch in needle if ch in blob) >= min_hits

    async def status(self, probe_ocr=False):
        detached, main, other, allwins = self.chat_candidates()
        running = bool(allwins)
        has_tray = any(w["cls"] == "Qt51514WxTrayIconMessageWindowClass" for w in allwins)
        main_big = [w for w in main if w["w"] >= 500 and w["h"] >= 380]
        main_small = [w for w in main if w["w"] < 520 and w["visible"]]
        logged_in = bool(detached) or bool(main_big) or has_tray
        notes = []
        if not running:
            notes.append("没有发现 Weixin.exe 进程：微信未启动。")
        elif not logged_in:
            if main_small:
                notes.append("检测到微信登录/扫码窗口，当前未登录。")
            else:
                notes.append("微信进程在运行，但没有发现已登录的会话窗口，疑似未登录。")

        hwnd, mode = self.pick_chat()
        result = {
            "wechatRunning": running,
            "loggedIn": logged_in,
            "trayIconPresent": has_tray,
            "chatWindow": None,
            "windows": [
                {"title": w["title"], "cls": w["cls"], "rect": w["rect"],
                 "visible": w["visible"], "size": [w["w"], w["h"]]}
                for w in allwins if w["cls"].startswith("Qt")
            ],
            "notes": notes,
            "ocrScale": _OCR_SCALE,
            "ocrLang": _OCR_LANG,
        }
        if hwnd:
            result["chatWindow"] = {
                "hwnd": hwnd,
                "mode": mode,
                "title": _window_text(hwnd),
                "rect": list(_rect(hwnd)),
            }
        if probe_ocr and hwnd:
            if ensure_visible(hwnd):
                scroll_to_bottom(hwnd, mode)
            lines = await self._capture_lines(hwnd, mode)
            blob = "".join(normalize(t) for t, *_ in lines)
            rendered = len(lines) >= 3
            if not rendered:
                # The window may have just been revealed; give it one more beat
                # before believing the chat is empty.
                ensure_visible(hwnd)
                await asyncio.sleep(0.8)
                lines = await self._capture_lines(hwnd, mode)
                blob = "".join(normalize(t) for t, *_ in lines)
                rendered = len(lines) >= 3
            result["chatRendered"] = rendered
            result["chatConfirmed"] = self._loose_contains(blob, CHAT_TITLE)
            result["visibleTextSample"] = blob[:300]
            if not rendered:
                # Structure already decided `loggedIn`; OCR silence alone is not
                # proof of a logout, so it only downgrades confidence here.
                result["notes"].append("聊天窗口存在但读不到任何内容（窗口可能刚被最小化）。")
        self.last_status = result
        return result

    async def _capture_lines(self, hwnd, mode):
        img = capture_window(hwnd)
        lines = await ocr_image(img)
        return lines

    async def _resolve_chat(self, auto_open=True):
        """Pick a chat window, trying to open one when none is available."""
        hwnd, mode = self.pick_chat(force=True)
        if hwnd is None and auto_open:
            try:
                await self.open_chat()
            except Exception as exc:
                _log("open_chat failed:", repr(exc))
            hwnd, mode = self.pick_chat(force=True)
        return hwnd, mode

    async def _render(self, hwnd, mode):
        img = capture_window(hwnd)
        lines = await ocr_image(img)
        return img, lines

    async def snapshot(self, auto_open=True, ensure_bottom=False):
        hwnd, mode = await self._resolve_chat(auto_open)
        if hwnd is None:
            raise RuntimeError("找不到「文件传输助手」聊天窗口；请先在微信里打开它。")
        # `ensure_bottom` is opt-in because wheeling the list moves the user's
        # cursor and view. The poll path never sets it: a background reader must
        # stay invisible. It is used only when the chat was explicitly opened.
        if ensure_bottom:
            scroll_to_bottom(hwnd, mode)
        img, lines = await self._render(hwnd, mode)
        if mode == "main" and not self._main_shows_chat(img, lines) and auto_open:
            # Another conversation is on screen: navigate back before reading.
            self.chat_hwnd = None
            try:
                await self.open_chat()
            except Exception as exc:
                _log("open_chat during snapshot failed:", repr(exc))
            hwnd, mode = self.pick_chat(force=True)
            if hwnd is not None:
                ensure_visible(hwnd)
                img, lines = await self._render(hwnd, mode)
        return self._annotate(build_messages(lines, img, mode))

    def _annotate(self, messages):
        """
        文件传输助手 is a self-chat: every bubble is WeChat-green, so the pixel
        colours cannot separate phone-originated text from PC-originated text.
        Direction is therefore decided by "did *we* send this?", with the
        bubble colour kept only as a diagnostic hint.
        """
        recent = [normalize(s) for s in self.sent_texts[-15:]]
        recent = [s for s in recent if s]
        for m in messages:
            m["bubbleDir"] = m.get("dir")
            mine = False
            for s in recent:
                if _similarity(m["text"], s) >= 0.72:
                    mine = True
                    break
                head = s.split("\n")[0][:14]
                if head and len(head) >= 3 and head in m["text"]:
                    mine = True
                    break
                if head and _similarity(m["text"][:len(head) + 8], head) >= 0.8:
                    mine = True
                    break
            m["ours"] = mine
            m["dir"] = "out" if mine else "in"
        return messages

    async def poll(self, auto_open=True):
        """
        Read-only scan for new inbound messages.

        Never scrolls, clicks, or changes focus. With `auto_open=False` (the
        plugin's default) it also refuses to *navigate* WeChat: if the chat is
        not already on screen it reports a skip instead of stealing the window
        from whoever is using the machine.
        """
        if not auto_open:
            hwnd, _mode = self.pick_chat(force=True)
            if hwnd is None:
                return {"messages": [], "skipped": "no-chat-window"}
        cur = await self.snapshot(auto_open=auto_open, ensure_bottom=False)
        if not self.primed:
            self.prev = cur
            self.primed = True
            return {"messages": [], "primed": True, "visible": len(cur)}
        appended = diff_new(self.prev, cur)
        self.prev = cur
        inbound = [m for m in appended if m["dir"] == "in"]
        return {"messages": inbound, "appended": appended,
                "primed": False, "visible": len(cur)}

    # -- sending ------------------------------------------------------------
    async def _confirm_recipient(self, hwnd, mode):
        """
        Make sure `hwnd` really shows 文件传输助手 before anything is pasted.

        A detached window is authoritative (its title is the chat), but the main
        window can be showing any conversation — pasting there would message the
        wrong person. Verified by OCR; on failure the chat is re-opened once.
        """
        if mode == "detached":
            return True
        ensure_visible(hwnd)
        _img, lines = await self._render(hwnd, "main")
        if self._main_shows_chat(_img, lines):
            return True
        _log("recipient unverified in the main window; re-opening the chat")
        try:
            await self.open_chat(force=True)
        except Exception as exc:
            _log("open_chat while confirming recipient failed:", repr(exc))
            return False
        new_hwnd, new_mode = self.pick_chat(force=True)
        if new_hwnd is None:
            return False
        if new_mode == "detached":
            return True
        ensure_visible(new_hwnd)
        _img2, lines2 = await self._render(new_hwnd, "main")
        return self._main_shows_chat(_img2, lines2)

    async def send(self, text: str, verify=False):
        hwnd, mode = await self._resolve_chat(True)
        if not hwnd:
            raise RuntimeError("找不到「文件传输助手」聊天窗口；请先在微信里打开它。")
        if not await self._confirm_recipient(hwnd, mode):
            raise RuntimeError(
                "无法确认微信当前打开的是「文件传输助手」，为避免把消息发给别人已取消发送。"
                "请手动在电脑微信里打开该会话。"
            )
        hwnd, mode = self.pick_chat(force=True)
        if not hwnd:
            raise RuntimeError("「文件传输助手」窗口在发送前消失了。")
        prev_fg = user32.GetForegroundWindow()
        saved_clip = _read_clipboard()
        try:
            if not force_foreground(hwnd):
                raise RuntimeError("无法把微信窗口切到前台，发送被跳过。")
            time.sleep(0.35)
            left, top, right, bottom = _rect(hwnd)
            w, h = right - left, bottom - top
            if mode == "detached":
                ix, iy = left + w * 0.5, bottom - h * 0.135
            else:
                ix, iy = left + w * 0.62, bottom - h * 0.135
            click_at(ix, iy)
            time.sleep(0.2)
            _write_clipboard(text)
            auto.SendKeys("{Ctrl}a", waitTime=0.15)
            auto.SendKeys("{Ctrl}v", waitTime=0.25)
            time.sleep(0.45)
            auto.SendKeys("{Enter}", waitTime=0.15)
            time.sleep(0.7)
            self.sent_texts.append(text)
            self.sent_texts = self.sent_texts[-40:]
            # Re-seed the cursor from the post-send view so our own message can
            # never be mistaken for an inbound command.
            verified = None
            try:
                cur = await self.snapshot()
                self.prev, self.primed = cur, True
                needle = normalize(text.splitlines()[0])[:24]
                if needle:
                    verified = any(m["dir"] == "out" and needle in m["text"]
                                   for m in cur[-8:])
            except Exception as exc:
                _log("post-send snapshot failed:", repr(exc))
                self.primed = False
            return {"sent": True, "chars": len(text), "mode": mode,
                    "hwnd": hwnd, "verified": verified}
        finally:
            if saved_clip:
                try:
                    _write_clipboard(saved_clip)
                except Exception:
                    pass
            if prev_fg and prev_fg != hwnd and _is_alive(prev_fg):
                try:
                    force_foreground(prev_fg)
                except Exception:
                    pass

    def close_chat_windows(self):
        """Close every 文件传输助手 window (WeChat only hides them)."""
        closed = 0
        for w in wechat_windows():
            if w["cls"] == WECHAT_CLASS and w["title"] == CHAT_TITLE:
                try:
                    user32.PostMessageW(w["hwnd"], WM_CLOSE, 0, 0)
                    closed += 1
                except Exception:
                    pass
        if closed:
            self.chat_hwnd, self.chat_mode = None, None
            time.sleep(0.8)
        return closed

    async def reopen_chat(self):
        """Force a fresh chat window, used when the reading view went stale."""
        self.close_chat_windows()
        return await self.open_chat()

    # -- screenshots --------------------------------------------------------
    def screenshot(self, max_width=0, window_title=None):
        """Capture the desktop (or one window) and return it as base64 PNG."""
        img = grab_screen(max_width=max_width, window_title=window_title)
        return {"png": image_to_png_base64(img), "width": img.width, "height": img.height}

    async def send_image(self, png_base64=None, caption=None, verify=False):
        """
        Paste an image into 文件传输助手.

        WeChat sends images through the clipboard on paste, so the PNG is
        decoded, placed on the clipboard as CF_DIB, and pasted like a user would.
        """
        import base64

        hwnd, mode = await self._resolve_chat(True)
        if not hwnd:
            raise RuntimeError("找不到「文件传输助手」聊天窗口；请先在微信里打开它。")
        if not await self._confirm_recipient(hwnd, mode):
            raise RuntimeError(
                "无法确认微信当前打开的是「文件传输助手」，为避免把图片发给别人已取消发送。"
            )
        hwnd, mode = self.pick_chat(force=True)
        if not hwnd:
            raise RuntimeError("「文件传输助手」窗口在发送前消失了。")
        img = None
        if png_base64:
            img = Image.open(io.BytesIO(base64.b64decode(png_base64))).convert("RGB")
        else:
            img = grab_screen()
        prev_fg = user32.GetForegroundWindow()
        saved_clip = _read_clipboard()
        try:
            if not force_foreground(hwnd):
                raise RuntimeError("无法把微信窗口切到前台，发送图片被跳过。")
            time.sleep(0.35)
            left, top, right, bottom = _rect(hwnd)
            w, h = right - left, bottom - top
            ix = left + w * (0.5 if mode == "detached" else 0.62)
            iy = bottom - h * 0.135
            if caption:
                _write_clipboard(caption)
                click_at(ix, iy)
                time.sleep(0.2)
                auto.SendKeys("{Ctrl}a", waitTime=0.15)
                auto.SendKeys("{Ctrl}v", waitTime=0.2)
                time.sleep(0.35)
                auto.SendKeys("{Enter}", waitTime=0.15)
                time.sleep(0.5)
            copy_image_to_clipboard(img)
            click_at(ix, iy)
            time.sleep(0.25)
            auto.SendKeys("{Ctrl}v", waitTime=0.35)
            time.sleep(1.0)
            auto.SendKeys("{Enter}", waitTime=0.2)
            time.sleep(0.8)
            if caption:
                self.sent_texts.append(caption)
                self.sent_texts = self.sent_texts[-40:]
            self.primed = False
            return {"sent": True, "width": img.width, "height": img.height, "mode": mode}
        finally:
            if saved_clip:
                try:
                    _write_clipboard(saved_clip)
                except Exception:
                    pass
            if prev_fg and prev_fg != hwnd and _is_alive(prev_fg):
                try:
                    force_foreground(prev_fg)
                except Exception:
                    pass

    # -- chat opening -------------------------------------------------------
    def _find_chat_entry(self, lines, width):
        """Locate the 文件传输助手 row in the main window's session list."""
        best = None
        for text, x, y, w, h in lines:
            if x > width * 0.40:
                continue
            if self._loose_contains(normalize(text), CHAT_TITLE, 4):
                if best is None or y < best[1]:
                    best = (x + w / 2.0, y + h / 2.0)
        return best

    def _main_shows_chat(self, img, lines):
        """Whether the right-hand panel header names 文件传输助手 (main mode)."""
        w, h = img.size
        for text, x, y, _tw, _th in lines:
            if y < h * 0.03 or y > h * 0.17:
                continue
            if x < w * 0.24:
                continue
            if self._loose_contains(normalize(text), CHAT_TITLE, 4):
                return True
        return False

    async def open_chat(self, force=False):
        """
        Make 文件传输助手 the visible chat.

        Opens in the detached window when one is already visible. Otherwise the
        tray-parked main window is restored and its session list is OCR'd so the
        matching row can be double-clicked — WeChat 4.x opens a dedicated window
        from a double click, while a single click only selects.

        With `force`, any existing detached window is closed first: re-showing a
        hidden one would render a stale page of the history instead of the
        newest messages, so a fresh window is opened instead.
        """
        if force:
            self.close_chat_windows()
        hwnd, mode = self.pick_chat(force=True)
        if hwnd and mode == "detached":
            # A visible detached window is authoritative and already current.
            return {"ok": True, "already": True, "mode": mode, "hwnd": hwnd}
        # Falling through with mode == 'main' is deliberate: the main window
        # might be showing any conversation, so the session entry is still
        # clicked (which usually spawns the dedicated window).

        _detached, main, _other, _all = self.chat_candidates()
        if not main:
            raise RuntimeError("微信主窗口不可见，无法打开「文件传输助手」；请手动打开一次。")
        m = sorted(main, key=lambda w: -w["w"] * w["h"])[0]
        target = m["hwnd"]
        prev_fg = user32.GetForegroundWindow()
        clicked = False
        try:
            if not force_foreground(target):
                raise RuntimeError("无法激活微信主窗口，打开「文件传输助手」失败。")
            time.sleep(0.6)
            left, top, _right, _bottom = _rect(target)
            img = capture_window(target)
            lines = await ocr_image(img)
            hit = self._find_chat_entry(lines, img.width)
            if hit is None:
                # Fall back to the search box in the top-left of the session list.
                click_at(left + img.width * 0.145, top + img.height * 0.078)
                time.sleep(0.6)
                auto.SendKeys(CHAT_TITLE, waitTime=0.3)
                time.sleep(1.4)
                img = capture_window(target)
                lines = await ocr_image(img)
                hit = self._find_chat_entry(lines, img.width)
            if hit is None:
                raise RuntimeError(
                    "在微信主窗口里找不到「文件传输助手」会话入口；"
                    "请手动在电脑微信里打开一次该会话。"
                )
            click_at(left + hit[0], top + hit[1], double=True)
            clicked = True
            time.sleep(1.8)
        finally:
            if prev_fg and _is_alive(prev_fg):
                try:
                    force_foreground(prev_fg)
                except Exception:
                    pass

        hwnd, mode = self.pick_chat(force=True)
        if hwnd and mode == "detached":
            return {"ok": True, "already": False, "mode": mode, "hwnd": hwnd, "clicked": clicked}
        if hwnd and mode == "main":
            img = capture_window(hwnd)
            lines = await ocr_image(img)
            if self._main_shows_chat(img, lines):
                return {"ok": True, "already": False, "mode": mode, "hwnd": hwnd, "clicked": clicked}
        # Last resort: reuse the main window even though the header did not match,
        # so a caller can still read *something* rather than failing outright.
        if mode == "main":
            return {"ok": True, "already": False, "mode": mode, "hwnd": hwnd,
                    "clicked": clicked, "unverified": True}
        raise RuntimeError("搜索后仍未找到「文件传输助手」聊天窗口，请手动打开一次。")


# ---------------------------------------------------------------- json server
class Server:
    def __init__(self):
        self.bridge = WeChatBridge()
        self._lock = asyncio.Lock()

    def send_json(self, obj):
        _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _REAL_STDOUT.flush()

    async def handle(self, req):
        rid = req.get("id")
        cmd = req.get("cmd")
        b = self.bridge
        try:
            if cmd == "ping":
                return {"id": rid, "ok": True, "result": {"pong": True, "t": time.time()}}
            if cmd == "status":
                return {"id": rid, "ok": True,
                        "result": await b.status(probe_ocr=bool(req.get("probeOcr")))}
            if cmd == "snapshot":
                return {"id": rid, "ok": True, "result": {"messages": await b.snapshot()}}
            if cmd == "poll":
                return {"id": rid, "ok": True,
                        "result": await b.poll(auto_open=bool(req.get("autoOpen", True)))}
            if cmd == "reset":
                b.prev, b.primed = [], False
                return {"id": rid, "ok": True, "result": {"reset": True}}
            if cmd == "open_chat":
                return {"id": rid, "ok": True, "result": await b.open_chat(bool(req.get("force")))}
            if cmd == "reopen_chat":
                return {"id": rid, "ok": True, "result": await b.reopen_chat()}
            if cmd == "send":
                text = req.get("text") or ""
                if not text.strip():
                    raise ValueError("send requires a non-empty text")
                return {"id": rid, "ok": True,
                        "result": await b.send(text, verify=bool(req.get("verify")))}
            if cmd == "screenshot":
                return {"id": rid, "ok": True, "result": b.screenshot(
                    # An absent `maxWidth` means native resolution, not 1600:
                    # `or 0` keeps a deliberate 0 from being swapped for a default.
                    max_width=int(req.get("maxWidth") if req.get("maxWidth") is not None else 0),
                    window_title=req.get("windowTitle") or None)}
            if cmd == "send_image":
                return {"id": rid, "ok": True, "result": await b.send_image(
                    png_base64=req.get("png"),
                    caption=req.get("caption"),
                    verify=bool(req.get("verify")))}
            if cmd == "shutdown":
                return {"id": rid, "ok": True, "result": {"bye": True}}
            return {"id": rid, "ok": False, "error": {"code": "UNKNOWN_COMMAND",
                                                      "message": f"unknown command {cmd!r}"}}
        except Exception as exc:  # keep the bridge alive on every failure
            _log("command failed:", cmd, repr(exc))
            traceback.print_exc(file=sys.stderr)
            return {"id": rid, "ok": False,
                    "error": {"code": type(exc).__name__, "message": str(exc)}}

    async def run(self):
        loop = asyncio.get_running_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as exc:
                self.send_json({"id": None, "ok": False,
                                "error": {"code": "BAD_JSON", "message": str(exc)}})
                continue
            async with self._lock:
                resp = await self.handle(req)
            self.send_json(resp)
            if req.get("cmd") == "shutdown":
                break


def sweep_stale_temp_files():
    """
    Delete scratch files left behind by an earlier run.

    `ocr_image` removes its own PNG in a `finally`, but a bridge killed mid-OCR
    (which happens on every restart and every crash) never reaches it, so those
    files accumulate in the system temp directory. Sweeping on startup keeps the
    plugin's footprint on the machine at zero between runs.
    """
    import glob
    import shutil
    import tempfile

    removed = 0
    for pattern in ("dsh-wechat-ocr-*.png", "dsh-shot-*"):
        for path in glob.glob(os.path.join(tempfile.gettempdir(), pattern)):
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.remove(path)
                removed += 1
            except OSError:
                pass
    if removed:
        _log(f"swept {removed} stale temp file(s)")


def main():
    if os.name != "nt":
        print("wechat_bridge requires Windows", file=sys.stderr)
        return 2
    auto.SetGlobalSearchTimeout(2.0)
    sweep_stale_temp_files()
    try:
        asyncio.run(Server().run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
