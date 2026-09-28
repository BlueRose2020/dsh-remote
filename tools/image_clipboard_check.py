# -*- coding: utf-8 -*-
"""
Verify the clipboard image round trip used by WeChat image sending.

`send_image` works by putting a PNG on the clipboard as `CF_DIB` and pasting it,
because WeChat has no other way to receive an image. That conversion is the
fragile part, and getting it wrong fails silently (WeChat just pastes nothing).
This builds a known image, puts it on the clipboard exactly as `send_image`
does, reads it back, and compares.

It deliberately does NOT send anything to WeChat — it only exercises the
clipboard path, so no chat is polluted.

    python tools/image_clipboard_check.py
"""

from __future__ import annotations

import io
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bridge"))

import win32clipboard as clip  # noqa: E402
import win32con  # noqa: E402
from PIL import Image  # noqa: E402

import wechat_bridge as wb  # noqa: E402

failures = []


def check(label, condition, detail=""):
    if not condition:
        failures.append(label)
    print(f"{'PASS' if condition else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")


def sample_image():
    """A small image with distinguishable pixels, so a swap is detectable."""
    image = Image.new("RGB", (64, 32))
    pixels = image.load()
    for y in range(32):
        for x in range(64):
            pixels[x, y] = (x * 4 % 256, y * 8 % 256, (x + y) * 3 % 256)
    return image


def read_clipboard_dib():
    clip.OpenClipboard()
    try:
        if not clip.IsClipboardFormatAvailable(win32con.CF_DIB):
            return None
        data = clip.GetClipboardData(win32con.CF_DIB)
    finally:
        clip.CloseClipboard()
    if not data:
        return None
    # CF_DIB is a BITMAPINFOHEADER followed by pixels; wrap it in a 14-byte
    # BITMAPFILEHEADER so Pillow will parse it.
    bi_size = struct.unpack("<I", data[:4])[0]
    header = b"BM" + struct.pack("<IHHI", 14 + len(data), 0, 0, 14 + bi_size)
    return Image.open(io.BytesIO(header + data))


def main():
    try:
        saved_text = wb._read_clipboard()
    except Exception:
        saved_text = ""

    source = sample_image()
    wb.copy_image_to_clipboard(source)

    clip.OpenClipboard()
    try:
        has_dib = bool(clip.IsClipboardFormatAvailable(win32con.CF_DIB))
        has_bitmap = bool(clip.IsClipboardFormatAvailable(win32con.CF_BITMAP))
    finally:
        clip.CloseClipboard()
    check("clipboard exposes CF_DIB after copy_image_to_clipboard", has_dib)
    check("clipboard also exposes CF_BITMAP (some pasters use it)", has_bitmap)

    restored = read_clipboard_dib()
    check("CF_DIB round-trips into a readable image", restored is not None)
    if restored is not None:
        check("round-tripped size matches", restored.size == source.size,
              f"{restored.size} vs {source.size}")
        left = source.convert("RGB").getpixel((7, 5))
        right = restored.convert("RGB").getpixel((7, 5))
        check("a sampled pixel survives the round trip", left == right, f"{left} vs {right}")

    # Put the user's text clipboard back.
    if saved_text:
        try:
            wb._write_clipboard(saved_text)
            print("clipboard text restored")
        except Exception as error:
            print(f"could not restore the clipboard: {error!r}")

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
