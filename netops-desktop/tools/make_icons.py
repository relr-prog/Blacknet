#!/usr/bin/env python3
"""Generate the BlackNet icon set from a single high-resolution source PNG.

No third-party imaging dependency: the source is decoded with zlib from the
stdlib, box-filtered with premultiplied alpha (no dark halos on edges), then
written back as PNG (for Linux/WSLg taskbar and the app chrome) and packed into
a multi-size Windows .ico.

Usage:
    python3 tools/make_icons.py [source.png] [assets_dir]

Defaults read ../../assets/blacknet.png relative to this file and write
blacknet.ico plus icons/blacknet-<size>.png into the assets directory.
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


# ----------------------------------------------------------------- PNG decode
def read_png(path: Path) -> tuple[int, int, bytearray]:
    """Decode an 8-bit non-interlaced greyscale/RGB/RGBA PNG into RGBA rows."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    pos = 8
    width = height = 0
    depth = color = interlace = 0
    idat = bytearray()
    palette = b""
    trns = b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height, depth, color, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"tRNS":
            trns = body
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
        pos += 12 + length
    if depth != 8 or interlace != 0:
        raise ValueError(f"unsupported PNG (depth={depth}, interlace={interlace})")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if channels is None:
        raise ValueError(f"unsupported PNG colour type {color}")

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(width * height * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif ftype != 0:
            raise ValueError(f"bad filter type {ftype} on row {y}")

        row = y * width * 4
        if color == 2:
            out[row:row + width * 4:4] = line[0::3]
            out[row + 1:row + width * 4:4] = line[1::3]
            out[row + 2:row + width * 4:4] = line[2::3]
            for x in range(width):
                out[row + x * 4 + 3] = 255
        elif color == 6:
            out[row:row + width * 4] = line
        elif color == 0:
            for x in range(width):
                v = line[x]
                i = row + x * 4
                out[i] = out[i + 1] = out[i + 2] = v
                out[i + 3] = 255
        elif color == 4:
            for x in range(width):
                v, a = line[x * 2], line[x * 2 + 1]
                i = row + x * 4
                out[i] = out[i + 1] = out[i + 2] = v
                out[i + 3] = a
        else:  # palette
            for x in range(width):
                idx = line[x]
                i = row + x * 4
                out[i] = palette[idx * 3]
                out[i + 1] = palette[idx * 3 + 1]
                out[i + 2] = palette[idx * 3 + 2]
                out[i + 3] = trns[idx] if idx < len(trns) else 255
        prev = line
    return width, height, out


# ---------------------------------------------------------------- PNG encode
def _chunk(ctype: bytes, body: bytes) -> bytes:
    return (struct.pack(">I", len(body)) + ctype + body
            + struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF))


def write_png(path: Path, width: int, height: int, rgba: bytes | bytearray) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


# ------------------------------------------------------------------- resize
def resize(src: int, src_h: int, rgba: bytearray, size: int) -> bytearray:
    """Box filter with premultiplied alpha; exact when size divides the source."""
    if size == src and src == src_h:
        return bytearray(rgba)
    dst = bytearray(size * size * 4)
    for dy in range(size):
        y0 = dy * src_h // size
        y1 = max(y0 + 1, (dy + 1) * src_h // size)
        for dx in range(size):
            x0 = dx * src // size
            x1 = max(x0 + 1, (dx + 1) * src // size)
            r = g = b = a = 0
            n = 0
            for y in range(y0, y1):
                base = y * src * 4
                for x in range(x0, x1):
                    i = base + x * 4
                    alpha = rgba[i + 3]
                    r += rgba[i] * alpha
                    g += rgba[i + 1] * alpha
                    b += rgba[i + 2] * alpha
                    a += alpha
                    n += 1
            o = (dy * size + dx) * 4
            if a:
                dst[o] = min(255, r // a)
                dst[o + 1] = min(255, g // a)
                dst[o + 2] = min(255, b // a)
            dst[o + 3] = a // n
    return dst


# ---------------------------------------------------------------------- ICO
def write_ico(path: Path, frames: list[tuple[int, bytearray]]) -> None:
    """Classic ICO: 32bpp BGRA DIB entries plus the AND mask."""
    entries = bytearray()
    blobs = bytearray()
    offset = 6 + 16 * len(frames)
    for size, rgba in frames:
        pixels = bytearray()
        stride = size * 4
        for y in range(size - 1, -1, -1):  # DIB rows are bottom-up
            row = rgba[y * stride:(y + 1) * stride]
            for x in range(size):
                i = x * 4
                r, g, b, a = row[i], row[i + 1], row[i + 2], row[i + 3]
                pixels += bytes((b, g, r, a))
        mask_stride = ((size + 31) // 32) * 4
        mask = bytearray()
        for y in range(size - 1, -1, -1):
            bits = bytearray(mask_stride)
            for x in range(size):
                if rgba[y * size * 4 + x * 4 + 3] == 0:
                    bits[x >> 3] |= 0x80 >> (x & 7)
            mask += bits
        dib = (struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0,
                           len(pixels) + len(mask), 0, 0, 0, 0)
               + pixels + mask)
        entries += struct.pack("<BBBBHHII", size & 0xFF, size & 0xFF, 0, 0, 1, 32,
                               len(dib), offset)
        blobs += dib
        offset += len(dib)
    header = struct.pack("<HHH", 0, 1, len(frames))
    path.write_bytes(header + entries + blobs)


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parent.parent
    source = Path(argv[1]) if len(argv) > 1 else root / "assets" / "blacknet.png"
    assets = Path(argv[2]) if len(argv) > 2 else root / "assets"
    if not source.is_file():
        print(f"missing source image: {source}", file=sys.stderr)
        return 1

    width, height, rgba = read_png(source)
    print(f"source {source.name}: {width}x{height}")
    (assets / "blacknet.png").write_bytes(source.read_bytes())
    icons = assets / "icons"
    icons.mkdir(parents=True, exist_ok=True)

    scaled: dict[int, bytearray] = {}
    for size in SIZES:
        data = resize(width, height, rgba, size)
        scaled[size] = data
        write_png(icons / f"blacknet-{size}.png", size, size, data)
        print(f"  icons/blacknet-{size}.png")

    write_ico(assets / "blacknet.ico",
              [(s, scaled[s]) for s in ICO_SIZES])
    print(f"  blacknet.ico ({len(ICO_SIZES)} sizes: {', '.join(map(str, ICO_SIZES))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))