"""Builds media/gitmetro-icons.woff from media/panel-icon.svg, so the status bar can show
the GitMetro mark ($(gitmetro-mark)). VS Code only accepts custom product icons as a font.

Fonts need filled outlines, so every stroke in the SVG is converted to its outline first.
Only needed when the mark changes; the generated font is committed.

    python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools skia-pathops
    /tmp/fontvenv/bin/python scripts/build-icon-font.py
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / 'media' / 'panel-icon.svg'
OUT = ROOT / 'media' / 'gitmetro-icons.woff'
CODEPOINT = 0xE000
EM = 1000
GRID = 24  # the SVG viewBox

svg = ET.parse(SVG).getroot()
width = float(svg.get('stroke-width', '1.5'))


def stroked(path: pathops.Path) -> pathops.Path:
    path.stroke(width, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
    path.convertConicsToQuads()  # round caps come out as conics, which boolean ops refuse
    return path


def from_d(d: str) -> pathops.Path:
    """Only the commands the mark uses: M, L, V, v (absolute or relative)."""
    p = pathops.Path()
    x = y = 0.0
    for cmd, args in re.findall(r'([MLVvlm])([^MLVvlm]*)', d):
        n = [float(v) for v in re.findall(r'-?\d*\.?\d+', args)]
        if cmd == 'M':
            x, y = n[0], n[1]
            p.moveTo(x, y)
        elif cmd == 'm':
            x, y = x + n[0], y + n[1]
            p.moveTo(x, y)
        elif cmd == 'L':
            for i in range(0, len(n), 2):
                x, y = n[i], n[i + 1]
                p.lineTo(x, y)
        elif cmd == 'l':
            for i in range(0, len(n), 2):
                x, y = x + n[i], y + n[i + 1]
                p.lineTo(x, y)
        elif cmd == 'V':
            y = n[0]
            p.lineTo(x, y)
        elif cmd == 'v':
            y += n[0]
            p.lineTo(x, y)
    return p


def circle(cx: float, cy: float, r: float) -> pathops.Path:
    p = pathops.Path()
    k = 0.5522847498 * r
    p.moveTo(cx + r, cy)
    p.cubicTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r)
    p.cubicTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy)
    p.cubicTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r)
    p.cubicTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy)
    p.close()
    return p


parts = []
for el in svg:
    tag = el.tag.split('}')[-1]
    if tag == 'path':
        parts.append(stroked(from_d(el.get('d'))))
    elif tag == 'circle':
        parts.append(stroked(circle(float(el.get('cx')), float(el.get('cy')), float(el.get('r')))))

outline = pathops.Path()
for p in parts:
    outline = pathops.op(outline, p, pathops.PathOp.UNION)

# SVG is y-down on a 24 grid; the font is y-up on a 1000 em with the baseline at the bottom.
scale = EM / GRID
pen = TTGlyphPen(None)
outline.draw(Cu2QuPen(TransformPen(pen, (scale, 0, 0, -scale, 0, EM)), max_err=0.5, reverse_direction=True))
mark = pen.glyph()
empty = TTGlyphPen(None).glyph()

fb = FontBuilder(EM, isTTF=True)
fb.setupGlyphOrder(['.notdef', 'mark'])
fb.setupCharacterMap({CODEPOINT: 'mark'})
fb.setupGlyf({'.notdef': empty, 'mark': mark})
fb.setupHorizontalMetrics({'.notdef': (EM, 0), 'mark': (EM, 0)})
fb.setupHorizontalHeader(ascent=EM, descent=0)
fb.setupNameTable({'familyName': 'GitMetro Icons', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=EM, sTypoDescender=0, usWinAscent=EM, usWinDescent=0)
fb.setupPost()
fb.font.flavor = 'woff'
fb.save(OUT)
print(f'wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes), U+{CODEPOINT:04X}')
