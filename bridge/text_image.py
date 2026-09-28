# -*- coding: utf-8 -*-
r"""
Render a chat reply as a PNG card.

Why this exists: `#status` and friends look awful in a phone chat — proportional
fonts, wrapping, and no alignment. The very same text rendered as a small card
reads at a glance, and both transports can already deliver images.

The first non-empty line is the title; the rest is drawn as a small Markdown
subset, because that is the shape an agent's answer already arrives in:

    # ## ###      headings (decreasing size, accent rule under an h1)
    - * + · 1.    bullets / numbered items, with a hanging indent
    > quote       muted text behind a grey bar
    ```           fenced code block: monospace on a grey panel
    ---           horizontal rule
    标签：值       label in the muted colour, value in the body colour
    **bold**      bold run        `code`  monospace chip    *italic*  italic

Anything unrecognised is drawn as a paragraph, so plain text still renders
exactly as before. Long lines wrap; a wrapped list item keeps its hanging
indent.

    python bridge/text_image.py <in.txt> <out.png> [maxWidth]
    # prints: <width>x<height>

Environment:
    DSH_IMAGE_FOOTER   footer stamp (default "DeepSeek Harness")
    DSH_IMAGE_AVATAR   path to a square PNG/JPG drawn as a round avatar in the
                       header (optional; the header falls back to a plain title)

Requires Pillow and a CJK font from `C:\Windows\Fonts`.
"""

from __future__ import annotations

import os
import re
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as error:  # pragma: no cover - dependency guard
    sys.stderr.write(f"Pillow is required: {error}\n")
    sys.exit(2)

# --------------------------------------------------------------------- palette
BG = (255, 255, 255)
HEADER_BG = (247, 249, 252)
BORDER = (226, 229, 235)
TITLE = (17, 17, 17)
BODY = (32, 33, 36)
MUTED = (124, 130, 141)
ACCENT = (37, 99, 235)
RULE = (236, 239, 244)
HARD_RULE = (219, 224, 232)
CODE_BG = (244, 246, 250)
CODE_FG = (42, 47, 56)
QUOTE_BAR = (205, 212, 224)

# -------------------------------------------------------------------- geometry
PADDING = 28
LINE_GAP = 10
TITLE_SIZE = 33
BODY_SIZE = 24
MONO_SIZE = 22
FOOTER_SIZE = 19
AVATAR_SIZE = 54
INDENT = 28
COLUMN_GAP = 26
RADIUS = 16

CANDIDATE_FONTS = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\Deng.ttf",
]
CANDIDATE_EMOJI = [
    r"C:\Windows\Fonts\seguiemj.ttf",
    r"C:\Windows\Fonts\SegoeUIEmoji.ttf",
]
CANDIDATE_MONO = [
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\consolab.ttf",
    r"C:\Windows\Fonts\cour.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
]

_FONT_CACHE: dict = {}


def load_font(size: int, bold: bool = False, mono: bool = False, emoji: bool = False):
    """First CJK / monospace / emoji font that loads, bold preferred when asked."""
    key = (size, bold, mono, emoji)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    if emoji:
        candidates = CANDIDATE_EMOJI
    elif mono:
        candidates = CANDIDATE_MONO
    else:
        candidates = CANDIDATE_FONTS[1::2] + CANDIDATE_FONTS[0::2] if bold else CANDIDATE_FONTS
    font = ImageFont.load_default()
    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            font = ImageFont.truetype(path, size)
            break
        except Exception:
            continue
    _FONT_CACHE[key] = font
    return font


def is_label_line(line: str):
    """Split `标签：值` into its two halves, when it is shaped that way."""
    for separator in ("：", ": "):
        if separator in line:
            head, _, tail = line.partition(separator)
            if 0 < len(head) <= 14 and tail.strip() != "":
                return head + separator, tail.strip()
    return None


# ------------------------------------------------------------- inline markdown
INLINE_RE = re.compile(r"\*\*(.+?)\*\*|`([^`]+)`|(?<!\*)\*([^*\n]+)\*(?!\*)")


def command_prefix():
    """The command prefix the cards should highlight (`#` unless overridden)."""
    return os.environ.get("DSH_IMAGE_PREFIX", "#") or "#"


def command_re():
    """
    Matches one `#command` token inside a line.

    The prefix is what makes a remote-control card skimmable: `#status` — and a
    passing mention of `#1` in a question prompt — are the parts a reader looks
    for, so they get the accent colour while everything else stays body text. A
    `#` followed by a space (a Markdown heading marker) is not a token, and
    neither is the `#` inside a URL fragment.
    """
    prefix = re.escape(command_prefix())
    body = r"[^\s#，。；：、（）()\[\]【】「」]+"
    return re.compile(rf"(?<![\w/]){prefix}(?:{body}|[<>])")


# ------------------------------------------------------------------- paths
#
# A path is the one token a card is full of that a reader scans rather than reads:
# `D:\work\projects\orders` is "the orders project" and nothing else. Drawing
# it as prose both makes it look like part of a sentence and lets the wrapper chop
# it in half, so it gets its own run kind, its own font, and its own break rule.
PATH_RE = re.compile(
    r"(?<![\w:/])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|/(?:Users|home|usr|var|opt|etc|mnt|tmp|srv|root)/)"
    r"[^\s，。；：、）)】」»\"'<>|]*"
)


def path_max_columns() -> int:
    """How long a path may be before its middle is elided; 0 disables eliding."""
    raw = os.environ.get("DSH_IMAGE_PATH_MAX", "").strip()
    if raw == "":
        return 44
    try:
        return max(0, int(raw))
    except ValueError:
        return 44


def elide_path(path: str, limit: int | None = None) -> str:
    r"""
    Shorten a long path in the middle: `D:\…\projects\orders`.

    The head names the volume and the tail names the project, so the middle is the
    only part worth dropping — and dropping it is what keeps a path from wrapping
    (a path broken across two lines is unreadable in a way a truncated one is not).
    """
    limit = path_max_columns() if limit is None else limit
    if limit <= 0 or len(path) <= limit:
        return path
    separators = [index for index, char in enumerate(path) if char in "\\/"]
    if len(separators) < 3:
        return path
    if path[1:2] == ":":
        root = path[:3]
    elif path[:2] == "\\\\":
        parts = path.split("\\")
        root = "\\\\" + (parts[2] if len(parts) > 2 else "") + "\\"
    else:
        root = "/"
    tail = path[separators[-2]:]
    candidate = f"{root}…{tail}"
    if len(candidate) > limit:
        candidate = f"{root}…{path[separators[-1]:]}"
    return candidate


def split_paths(runs):
    """Split plain `n` runs further so path tokens become `p` runs (elided)."""
    out = []
    for text, kind in runs:
        if kind != "n" or not any(mark in text for mark in ("\\", "/")):
            out.append((text, kind))
            continue
        position = 0
        for match in PATH_RE.finditer(text):
            token = match.group(0).rstrip(".,;:)]}")
            trailing = match.group(0)[len(token):]
            if match.start() > position:
                out.append((text[position:match.start()], "n"))
            if token:
                out.append((elide_path(token), "p"))
            if trailing:
                out.append((trailing, "n"))
            position = match.end()
        if position < len(text):
            out.append((text[position:], "n"))
    return out


def is_emoji(char: str) -> bool:
    """
    Whether a codepoint should be drawn with the colour-emoji face.

    A CJK font has no emoji glyphs, so `🎉` used to come out as a blank box. The
    ranges below are the pictographic blocks plus the two joiners that keep a
    ZWJ sequence and a variation selector attached to the glyph they modify.
    """
    code = ord(char)
    return (
        0x1F000 <= code <= 0x1FAFF
        or 0x1F1E6 <= code <= 0x1F1FF
        or 0x2600 <= code <= 0x27BF
        or 0x2B00 <= code <= 0x2BFF
        or 0x1F900 <= code <= 0x1F9FF
        or code in (0xFE0F, 0x200D, 0x20E3)
    )


def split_emoji(runs):
    """Split `n` runs further so emoji become `e` runs (their own font)."""
    out = []
    for text, kind in runs:
        if kind != "n" or not any(is_emoji(char) for char in text):
            out.append((text, kind))
            continue
        current = ""
        current_kind = None
        for char in text:
            char_kind = "e" if is_emoji(char) else "n"
            if char_kind != current_kind:
                if current:
                    out.append((current, current_kind))
                current = char
                current_kind = char_kind
            else:
                current += char
        if current:
            out.append((current, current_kind))
    return out


def split_commands(text: str):
    """Split one plain chunk into normal text and `#command` runs."""
    if not text:
        return []
    runs = []
    position = 0
    for match in command_re().finditer(text):
        if match.start() > position:
            runs.append((text[position:match.start()], "n"))
        runs.append((match.group(0), "k"))
        position = match.end()
    if position < len(text):
        runs.append((text[position:], "n"))
    return runs


def parse_inline(text: str):
    """
    `**bold**` / `` `code` `` / `*italic*` / `#command` → `(text, kind)` runs.

    Kinds: `n` normal, `b` bold, `c` code, `i` italic, `k` command.
    """
    runs = []
    position = 0
    for match in INLINE_RE.finditer(text):
        if match.start() > position:
            runs.extend(split_commands(text[position:match.start()]))
        if match.group(1) is not None:
            runs.append((match.group(1), "b"))
        elif match.group(2) is not None:
            runs.append((match.group(2), "c"))
        else:
            runs.append((match.group(3), "i"))
        position = match.end()
    if position < len(text):
        runs.extend(split_commands(text[position:]))
    if not runs:
        runs.append((text, "n"))
    return split_paths(split_emoji(runs))


# ----------------------------------------------------------------- block model
def split_cells(line: str):
    """
    One table row → its cells, or None when the line is not a row.

    A tab is the column separator (that is what a person types when they mean
    "column"), and ` │ ` is accepted too because it survives a plain-text chat
    where a tab collapses. Everything else is an ordinary line.

    Only the RIGHT side is trimmed: an empty leading cell is a real cell — that
    is how a continuation row (a directory under its session) says "skip the
    first two columns and start at the third".
    """
    text = line.rstrip()
    if "\t" in text:
        return [cell.strip() for cell in text.split("\t")]
    if " │ " in text:
        return [cell.strip() for cell in text.split(" │ ")]
    return None


def parse_blocks(lines):
    """Turn rendered lines into a list of typed blocks."""
    blocks = []
    index = 0
    while index < len(lines):
        raw = lines[index]
        text = raw.strip()
        if text == "":
            blocks.append({"kind": "space"})
            index += 1
            continue
        # Consecutive tab-separated lines are one table: columns are measured
        # across the whole block, which is the only way they can line up.
        cells = split_cells(raw)
        if cells is not None and len(cells) >= 2:
            rows = []
            while index < len(lines):
                row = split_cells(lines[index])
                if row is None or len(row) < 2:
                    break
                rows.append(row)
                index += 1
            blocks.append({"kind": "table", "rows": rows})
            continue
        if text in ("---", "***", "___", "—", "——"):
            blocks.append({"kind": "rule"})
            index += 1
            continue
        if text.startswith("```"):
            code = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code.append(lines[index])
                index += 1
            index += 1  # closing fence (or end of input)
            blocks.append({"kind": "code", "lines": code})
            continue
        heading = re.match(r"^(#{1,4})\s+(.*)$", text)
        if heading is not None:
            blocks.append({
                "kind": "head",
                "level": len(heading.group(1)),
                "runs": parse_inline(heading.group(2)),
            })
            index += 1
            continue
        bullet = re.match(r"^([-*+]|[·•])\s+(.*)$", text)
        if bullet is not None:
            blocks.append({"kind": "item", "marker": "·", "runs": parse_inline(bullet.group(2))})
            index += 1
            continue
        numbered = re.match(r"^(\d{1,2})[.)、]\s+(.*)$", text)
        if numbered is not None:
            blocks.append({"kind": "item", "marker": f"{numbered.group(1)}.", "runs": parse_inline(numbered.group(2))})
            index += 1
            continue
        if text.startswith(">"):
            blocks.append({"kind": "quote", "runs": parse_inline(text.lstrip("> ").strip())})
            index += 1
            continue
        label = is_label_line(text)
        if label is not None:
            head, value = label
            blocks.append({"kind": "field", "head": head, "runs": parse_inline(value)})
            index += 1
            continue
        blocks.append({"kind": "para", "runs": parse_inline(text)})
        index += 1
    return blocks


# ------------------------------------------------------------------- rendering
def run_font(fonts, kind, base):
    """Font for one inline run, given the block's base role."""
    if kind == "e":
        return fonts["emoji"]
    if kind in ("c", "p"):
        return fonts["mono"]
    if kind == "b":
        return fonts.get(f"{base}b") or fonts[base]
    if kind == "k":
        # Colour, not weight: bold next to regular text sits a pixel off the
        # shared baseline, and a row of `#commands` that jitters vertically is
        # worse than one that is merely blue.
        return fonts[base]
    return fonts[base]


def draw_run(draw, x, y, text, font, color, kind):
    """Draw one run; emoji runs ask Pillow for the glyph's own colours."""
    draw.text((x, y), text, font=font, fill=color, embedded_color=(kind == "e"))


def run_color(kind, base=BODY, accent=True):
    """
    Colour for one inline run.

    `accent=False` is for table cells: a two-column table is supposed to read as
    a table because of its alignment, so colouring every command in it just makes
    the column noisy. Prose keeps the accent — there a `#command` is a pointer,
    not a column.
    """
    if kind in ("c", "k"):
        return ACCENT if accent else base
    if kind in ("i", "p"):
        # Dimmed even inside a table: a path is reference material, and the columns
        # there carry the layout, not the colour.
        return MUTED
    return base


def merge(chars):
    """Collapse a per-character line back into runs."""
    runs = []
    for char, kind in chars:
        if runs and runs[-1][1] == kind:
            runs[-1][0] += char
        else:
            runs.append([char, kind])
    return [(text, kind) for text, kind in runs]


def run_units(text, kind):
    """
    The atoms a wrap may break between.

    Ordinary text breaks per character (as it always did). A path breaks only at a
    separator, so `archive-2026\branch` can never come out as `archive-2026\branc`
    + `h` — the worst thing a card full of paths can do.
    """
    if kind != "p":
        return [(char, kind) for char in text]
    parts = re.findall(r"[\\/][^\\/]*|[^\\/]+", text)
    return [(part, "p") for part in parts] or [(text, "p")]


def wrap_runs(draw, runs, fonts, base, max_width, indent=0):
    """Greedy wrap across mixed-font runs, breaking only between whole units."""
    lines = []
    current = []
    width = 0.0
    available = max_width
    for text, kind in runs:
        font = run_font(fonts, kind, base)
        for unit, unit_kind in run_units(text, kind):
            char_width = draw.textlength(unit, font=font)
            if current and width + char_width > available:
                lines.append(merge(current))
                current = []
                width = 0.0
                available = max_width - indent
            current.append((unit, unit_kind))
            width += char_width
    if current or not lines:
        lines.append(merge(current))
    return lines


def load_avatar(path):
    """Square, round-cropped, supersampled avatar — or None when unusable."""
    if not path or not os.path.exists(path):
        return None
    try:
        source = Image.open(path).convert("RGB")
    except Exception:
        return None
    edge = min(source.size)
    left = (source.width - edge) // 2
    top = (source.height - edge) // 2
    square = source.crop((left, top, left + edge, top + edge)).resize((256, 256), Image.LANCZOS)
    scale = 4
    mask = Image.new("L", (256 * scale, 256 * scale), 0)
    ImageDraw.Draw(mask).ellipse([(0, 0), (256 * scale - 1, 256 * scale - 1)], fill=255)
    mask = mask.resize((256, 256), Image.LANCZOS)
    round_image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    round_image.paste(square, (0, 0), mask)
    return round_image.resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)


def render(text: str, max_width: int, out_path: str):
    """Draw the card and save it. Returns `(width, height)`."""
    raw_lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    while raw_lines and raw_lines[0].strip() == "":
        raw_lines.pop(0)
    while raw_lines and raw_lines[-1].strip() == "":
        raw_lines.pop()
    if not raw_lines:
        raw_lines = ["DSH"]

    title = raw_lines[0].strip()
    blocks = parse_blocks(raw_lines[1:])

    fonts = {
        "title": load_font(TITLE_SIZE, bold=True),
        "head1": load_font(BODY_SIZE + 8, bold=True),
        "head2": load_font(BODY_SIZE + 4, bold=True),
        "head3": load_font(BODY_SIZE + 1, bold=True),
        "head4": load_font(BODY_SIZE, bold=True),
        "body": load_font(BODY_SIZE),
        "bodyb": load_font(BODY_SIZE, bold=True),
        "mono": load_font(MONO_SIZE),
        "monob": load_font(MONO_SIZE, bold=True),
        "emoji": load_font(int(BODY_SIZE * 1.05), emoji=True),
        "footer": load_font(FOOTER_SIZE),
    }

    inner = max(320, max_width - PADDING * 2)
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))

    avatar = load_avatar(os.environ.get("DSH_IMAGE_AVATAR", ""))
    header_height = AVATAR_SIZE + 6 if avatar is not None else int(TITLE_SIZE * 1.5)
    title_left = PADDING + AVATAR_SIZE + 16 if avatar is not None else PADDING
    title_area = max_width - title_left - PADDING
    title_font = fonts["title"]
    for size in (TITLE_SIZE, TITLE_SIZE - 3, TITLE_SIZE - 7, TITLE_SIZE - 11):
        candidate = load_font(size, bold=True)
        if probe.textlength(title, font=candidate) <= title_area:
            title_font = candidate
            break
    else:
        title_font = load_font(TITLE_SIZE - 11, bold=True)
        while title and probe.textlength(title + "…", font=title_font) > title_area:
            title = title[:-1]
        title = title + "…" if title else "DSH"

    # Measure every block before drawing anything, so the canvas fits exactly.
    # Labels first: every `标签：值` row in one card shares a value column, which
    # is what turns `#status`/`#help` from a ragged list into a readable table.
    head_widths = [probe.textlength(block["head"], font=fonts["body"])
                   for block in blocks if block["kind"] == "field"]
    column = max(head_widths) + 6 if head_widths else 0
    # A label wider than 45 % of the card is prose, not a table; fall back to
    # per-row columns so one long label cannot squeeze every value.
    if column > inner * 0.45:
        column = 0

    layout = []
    for block in blocks:
        kind = block["kind"]
        if kind == "space":
            layout.append((block, [], LINE_GAP))
            continue
        if kind == "rule":
            layout.append((block, [], LINE_GAP + 1))
            continue
        if kind == "code":
            lines = []
            for raw in block["lines"]:
                pieces = wrap_runs(probe, [(raw, "c")], fonts, "mono", inner - INDENT, indent=INDENT)
                lines.extend(pieces)
            if not lines:
                lines = [[]]
            layout.append((block, lines, int(MONO_SIZE * 1.5) * len(lines) + 12))
            continue
        if kind == "head":
            base = f"head{min(4, block['level'])}"
            size = {"head1": BODY_SIZE + 8, "head2": BODY_SIZE + 4, "head3": BODY_SIZE + 1, "head4": BODY_SIZE}[base]
            lines = wrap_runs(probe, block["runs"], fonts, base, inner)
            extra = 6 if block["level"] == 1 else 0
            layout.append((block, lines, int(size * 1.45) * len(lines) + extra))
            continue
        if kind == "item":
            marker_width = probe.textlength(block["marker"] + " ", font=fonts["body"])
            lines = wrap_runs(probe, block["runs"], fonts, "body", inner - marker_width - 4, indent=marker_width)
            block["marker_width"] = marker_width
            layout.append((block, lines, int(BODY_SIZE * 1.45) * len(lines)))
            continue
        if kind == "quote":
            lines = wrap_runs(probe, block["runs"], fonts, "body", inner - INDENT, indent=INDENT)
            layout.append((block, lines, int(BODY_SIZE * 1.45) * len(lines) + 8))
            continue
        if kind == "table":
            # Three columns, measured across every row: command | shorthand |
            # description. The first two are monospace so `#status` and `#s` start
            # at exactly the same x on every row — the columns *are* the layout,
            # which is why nothing here needs colour.
            rows = block["rows"]
            columns = max(len(row) for row in rows)
            widths = [0] * columns
            for row in rows:
                for i, cell in enumerate(row):
                    font = fonts["mono"] if i < 2 else fonts["body"]
                    widths[i] = max(widths[i], probe.textlength(cell, font=font))
            block["widths"] = widths
            block["columns"] = columns
            text_x = PADDING + sum(widths[:2]) + COLUMN_GAP * min(2, columns - 1)
            description_width = max(120, inner - (text_x - PADDING))
            rendered = []
            row_height = int(BODY_SIZE * 1.45)
            for row in rows:
                description = row[2] if len(row) > 2 else ""
                rendered.append(wrap_runs(probe, parse_inline(description), fonts, "body", description_width))
            block["rendered"] = rendered
            layout.append((block, [], row_height * sum(len(lines) for lines in rendered)))
            continue
        if kind == "field":
            # The head may itself contain `#command` runs, so draw it as runs too.
            head_runs = parse_inline(block["head"])
            block["head_runs"] = head_runs
            own = sum(probe.textlength(text, font=run_font(fonts, run_kind, "body"))
                      for text, run_kind in head_runs)
            block["column"] = column if column > own else own
            value_width = sum(probe.textlength(text, font=run_font(fonts, run_kind, "body"))
                              for text, run_kind in block["runs"])
            # A value that cannot fit beside its label moves *below* it. Right-
            # aligning a long path into the value column pushed it to the card's
            # edge and wrapped it under the label — which reads as a layout bug.
            block["stacked"] = value_width > inner - block["column"] - COLUMN_GAP
            if block["stacked"]:
                lines = wrap_runs(probe, block["runs"], fonts, "body", inner - INDENT, indent=INDENT)
            else:
                lines = wrap_runs(probe, block["runs"], fonts, "body", inner - block["column"], indent=block["column"])
            extra = int(BODY_SIZE * 1.45) if block["stacked"] else 0
            layout.append((block, lines, int(BODY_SIZE * 1.45) * len(lines) + extra))
            continue
        lines = wrap_runs(probe, block["runs"], fonts, "body", inner)
        layout.append((block, lines, int(BODY_SIZE * 1.45) * len(lines)))

    height = PADDING + header_height + LINE_GAP + int(FOOTER_SIZE * 1.8) + PADDING
    for _block, _lines, block_height in layout:
        height += block_height

    width = max_width
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)

    # Card: rounded white body, hairline border, tinted header band, accent spine.
    draw.rounded_rectangle([(0, 0), (width - 1, height - 1)], radius=RADIUS, fill=BG, outline=BORDER, width=1)
    header_bottom = PADDING + header_height
    draw.rounded_rectangle([(6, 1), (width - 2, header_bottom)], radius=RADIUS - 3, fill=HEADER_BG)
    draw.rounded_rectangle([(0, 0), (6, height - 1)], radius=3, fill=ACCENT)

    title_y = PADDING + (header_height - int(title_font.size * 1.25)) // 2
    if avatar is not None:
        image.paste(avatar, (PADDING, PADDING), avatar)
    draw.text((title_left, title_y), title, font=title_font, fill=TITLE)
    draw.line([(PADDING, header_bottom), (width - PADDING, header_bottom)], fill=RULE, width=1)

    y = header_bottom + LINE_GAP
    for block, lines, _block_height in layout:
        kind = block["kind"]
        if kind == "space":
            y += LINE_GAP
            continue
        if kind == "rule":
            draw.line([(PADDING, y + LINE_GAP // 2), (width - PADDING, y + LINE_GAP // 2)], fill=HARD_RULE, width=2)
            y += LINE_GAP + 1
            continue
        if kind == "code":
            panel_height = int(MONO_SIZE * 1.5) * len(lines) + 12
            draw.rounded_rectangle([(PADDING, y), (width - PADDING, y + panel_height)], radius=8, fill=CODE_BG)
            cursor = y + 6
            for line in lines:
                x = PADDING + 12
                for text, run_kind in line:
                    font = fonts["mono"] if run_kind != "e" else fonts["emoji"]
                    draw_run(draw, x, cursor, text, font, CODE_FG, run_kind)
                    x += draw.textlength(text, font=font)
                cursor += int(MONO_SIZE * 1.5)
            y += panel_height
            continue
        if kind == "head":
            base = f"head{min(4, block['level'])}"
            size = {"head1": BODY_SIZE + 8, "head2": BODY_SIZE + 4, "head3": BODY_SIZE + 1, "head4": BODY_SIZE}[base]
            line_height = int(size * 1.45)
            for line in lines:
                x = PADDING
                for text, kind_runs in line:
                    font = run_font(fonts, kind_runs, base)
                    draw_run(draw, x, y, text, font, run_color(kind_runs, TITLE), kind_runs)
                    x += draw.textlength(text, font=font)
                y += line_height
            if block["level"] == 1:
                draw.line([(PADDING, y + 2), (PADDING + 72, y + 2)], fill=ACCENT, width=3)
                y += 6
            continue
        if kind == "quote":
            block_height = int(BODY_SIZE * 1.45) * len(lines) + 8
            draw.rounded_rectangle([(PADDING, y), (PADDING + 3, y + block_height - 8)], radius=2, fill=QUOTE_BAR)
            cursor = y + 4
            for line in lines:
                x = PADDING + INDENT
                for text, kind_runs in line:
                    font = run_font(fonts, kind_runs, "body")
                    color = run_color(kind_runs, MUTED)
                    draw_run(draw, x, cursor, text, font, color, kind_runs)
                    x += draw.textlength(text, font=font)
                cursor += int(BODY_SIZE * 1.45)
            y += block_height
            continue
        if kind == "item":
            marker_width = block.get("marker_width", 0)
            for index, line in enumerate(lines):
                x = PADDING
                if index == 0:
                    draw.text((PADDING, y), block["marker"], font=fonts["body"], fill=ACCENT)
                x = PADDING + marker_width + 4
                for text, kind_runs in line:
                    font = run_font(fonts, kind_runs, "body")
                    color = run_color(kind_runs)
                    draw_run(draw, x, y, text, font, color, kind_runs)
                    x += draw.textlength(text, font=font)
                y += int(BODY_SIZE * 1.45)
            continue
        if kind == "table":
            widths = block.get("widths", [0, 0, 0])
            columns = block.get("columns", 3)
            rows = block["rows"]
            rendered = block.get("rendered", [])
            row_height = int(BODY_SIZE * 1.45)
            for index, row in enumerate(rows):
                # The monospace face is smaller than the body face, so nudge it
                # down to sit on the same optical baseline as the description.
                mono_y = y + max(0, (BODY_SIZE - MONO_SIZE) // 2)
                x = PADDING
                if len(row) > 0 and row[0] != "":
                    draw.text((x, mono_y), row[0], font=fonts["mono"], fill=BODY)
                x += widths[0] + COLUMN_GAP
                if columns >= 2 and len(row) > 1 and row[1] != "":
                    draw.text((x, mono_y), row[1], font=fonts["mono"], fill=MUTED)
                if columns >= 3:
                    text_x = PADDING + widths[0] + widths[1] + COLUMN_GAP * 2
                    cursor = y
                    for line in rendered[index] if index < len(rendered) else []:
                        run_x = text_x
                        for text, run_kind in line:
                            font = run_font(fonts, run_kind, "body")
                            draw_run(draw, run_x, cursor, text, font,
                                     run_color(run_kind, BODY, accent=False), run_kind)
                            run_x += draw.textlength(text, font=font)
                        cursor += row_height
                    y += row_height * max(1, len(rendered[index]) if index < len(rendered) else 1)
                else:
                    y += row_height
            continue
        if kind == "field":
            column = block.get("column", 0)
            stacked = block.get("stacked", False)
            head_drawn = False
            for line in lines:
                if not head_drawn:
                    head_x = PADDING
                    for head_text, head_kind in block.get("head_runs", [(block["head"], "n")]):
                        head_font = run_font(fonts, head_kind, "body")
                        draw_run(draw, head_x, y, head_text, head_font,
                                 run_color(head_kind, MUTED, accent=False), head_kind)
                        head_x += draw.textlength(head_text, font=head_font)
                    head_drawn = True
                    if stacked:
                        # The label owns this line; the value starts on the next.
                        y += int(BODY_SIZE * 1.45)
                        continue
                x = PADDING + (INDENT if stacked else column)
                for text, kind_runs in line:
                    font = run_font(fonts, kind_runs, "body")
                    color = run_color(kind_runs, BODY, accent=False)
                    draw_run(draw, x, y, text, font, color, kind_runs)
                    x += draw.textlength(text, font=font)
                y += int(BODY_SIZE * 1.45)
            continue
        for line in lines:
            x = PADDING
            for text, kind_runs in line:
                font = run_font(fonts, kind_runs, "body")
                color = run_color(kind_runs)
                draw_run(draw, x, y, text, font, color, kind_runs)
                x += draw.textlength(text, font=font)
            y += int(BODY_SIZE * 1.45)

    footer_y = height - PADDING - int(FOOTER_SIZE * 1.2)
    draw.line([(PADDING, footer_y - 6), (width - PADDING, footer_y - 6)], fill=RULE, width=1)
    stamp = os.environ.get("DSH_IMAGE_FOOTER", "DeepSeek Harness")
    draw.text((PADDING, footer_y), stamp, font=fonts["footer"], fill=MUTED)
    tag = "DSH"
    draw.text((width - PADDING - probe.textlength(tag, font=fonts["footer"]), footer_y), tag,
              font=fonts["footer"], fill=ACCENT)

    image.save(out_path, "PNG", optimize=True)
    return image.size


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(argv) < 3:
        sys.stderr.write("usage: text_image.py <in.txt> <out.png> [maxWidth]\n")
        return 2
    in_path, out_path = argv[1], argv[2]
    max_width = int(argv[3]) if len(argv) > 3 else 900
    with open(in_path, "r", encoding="utf-8") as handle:
        text = handle.read()
    width, height = render(text, max(360, min(1600, max_width)), out_path)
    print(f"{width}x{height}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
