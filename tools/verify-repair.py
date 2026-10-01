# -*- coding: utf-8 -*-
"""校验重建结果：按损坏链路正向变换后应与 .corrupt（去掉 BOM）一致。"""
import os

DIR = r"F:\qtMusic\qt-pc\src-tauri\src\db\store"
CORRUPT = os.path.join(DIR, "tests.rs.corrupt")


def forward(text):
    buf = text.encode("utf-8")
    out = []
    i = 0
    n = len(buf)
    while i < n:
        b1 = buf[i]
        if b1 < 0x80:
            out.append(chr(b1))
            i += 1
            continue
        if i + 1 < n:
            b2 = buf[i + 1]
            trail_ok = (0x40 <= b2 <= 0x7E) or (0x80 <= b2 <= 0xFE)
            if 0x81 <= b1 <= 0xFE and trail_ok:
                try:
                    out.append(bytes([b1, b2]).decode("gbk"))
                    i += 2
                    continue
                except UnicodeDecodeError:
                    pass
        out.append("?")
        i += 2 if i + 1 < n else 1
    return "".join(out).encode("utf-8")


corrupt = open(CORRUPT, "rb").read()
if corrupt[:3] == b"\xef\xbb\xbf":
    corrupt = corrupt[3:]
new = open(os.path.join(DIR, "tests.rs"), encoding="utf-8").read()
got = forward(new)

print("期望字节:", len(corrupt), " 得到:", len(got), " ->", "完全一致" if got == corrupt else "有差异")

if got != corrupt:
    diffs = [k for k in range(min(len(got), len(corrupt))) if got[k] != corrupt[k]]
    print("差异字节数:", len(diffs), "/", min(len(got), len(corrupt)))
    # 归组展示
    shown = 0
    last = -100
    for k in diffs:
        if k - last < 30:
            last = k
            continue
        last = k
        shown += 1
        if shown > 40:
            break
        a = got[max(0, k - 30):k + 30]
        b = corrupt[max(0, k - 30):k + 30]
        try:
            at = a.decode("utf-8", "replace")
            bt = b.decode("utf-8", "replace")
        except Exception:
            at = bt = "?"
        print(f"  @{k}\n     重建: {at!r}\n     实际: {bt!r}")