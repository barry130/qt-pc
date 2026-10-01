"""从（损坏前编译出来的）测试二进制里提取中文字符串字面量，作为 tests.rs 代码字面量的真值。"""
import glob
import os
import re

DEPS = r"F:\qtMusic\qt-pc\src-tauri\target\debug\deps"
cands = glob.glob(os.path.join(DEPS, "quietmusic-*.exe"))
cands += glob.glob(os.path.join(DEPS, "quietmusic-*"))
cands = [c for c in cands if c.lower().endswith(".exe")]
if not cands:
    print("没找到 quietmusic-*.exe")
    raise SystemExit(1)
newest = max(cands, key=os.path.getmtime)
print("使用二进制:", newest)
print("修改时间:", __import__("datetime").datetime.fromtimestamp(os.path.getmtime(newest)))
print("大小:", os.path.getsize(newest))

raw = open(newest, "rb").read()

# 提取可打印 UTF-8 串（含非 ASCII）
strings = re.findall(rb"[\x20-\x7e\xc2-\xf4][\x20-\x7e\x80-\xbf]{1,300}", raw)
cjk = re.compile("[\u4e00-\u9fff]")
seen = []
for s in strings:
    try:
        t = s.decode("utf-8")
    except UnicodeDecodeError:
        continue
    if cjk.search(t):
        seen.append(t)

uniq = sorted(set(seen))
print("含中文的串（去重）:", len(uniq))
out = r"F:\qtMusic\qt-pc\tools\binary-literals.txt"
with open(out, "w", encoding="utf-8") as f:
    for t in uniq:
        f.write(t + "\n")
print("已写出", out)
print()
print("===== 与收藏/歌单测试相关的串 =====")
KW = ["歌单", "收藏", "离线", "队列", "换号", "登出", "开车听", "他端", "幸存", "稻香", "七里", "归属", "云端", "幽灵", "确认点"]
for t in uniq:
    if any(k in t for k in KW):
        print("  ", t)