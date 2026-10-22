#!/usr/bin/env python3
"""生成资源嗅探插件的 PNG 图标 (16/48/128)，纯标准库实现，无第三方依赖。"""
import struct
import zlib
import os


def write_png(path, size, draw):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        for x in range(size):
            raw += bytes(draw(x, y, size))
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data +
                struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', comp))
        f.write(chunk(b'IEND', b''))


def area(px, py, qx, qy, rx, ry):
    return (qx - px) * (ry - py) - (qy - py) * (rx - px)


def icon_draw(x, y, size):
    # 背景：紫->蓝渐变
    t = x / size
    r = int(94 + t * 40)
    g = int(53 + (y / size) * 60)
    b = int(177 + (1 - t) * 30)

    # 居中向右的播放三角
    cx, cy = size / 2, size / 2
    ax, ay = cx - size * 0.16, cy - size * 0.24
    bx, by = cx - size * 0.16, cy + size * 0.24
    cxp, cyp = cx + size * 0.28, cy
    a1 = area(ax, ay, bx, by, x, y)
    a2 = area(bx, by, cxp, cyp, x, y)
    a3 = area(cxp, cyp, ax, ay, x, y)
    inside = (a1 >= 0 and a2 >= 0 and a3 >= 0) or (a1 <= 0 and a2 <= 0 and a3 <= 0)
    if inside:
        return (255, 255, 255, 255)
    return (r, g, b, 255)


def main():
    os.makedirs('icons', exist_ok=True)
    for s in (16, 48, 128):
        write_png(os.path.join('icons', 'icon%d.png' % s), s, icon_draw)
    print('icons generated:', os.listdir('icons'))


if __name__ == '__main__':
    main()
