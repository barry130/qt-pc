"""1) 从损坏前编译的测试二进制里取中文字面量真值
2) 分类 recovered 文本里的受损点是注释还是代码
"""
import re
import os

BIN = r"F:\qtMusic\qt-pc\src-tauri\target\debug\deps\quietmusic_lib-76f9b0148575d7b6.exe"
REC = r"F:\qtMusic\qt-pc\src-tauri\src\db\store\tests.recovered.rs"

raw = open(BIN, "rb").read()
pat = re.compile(rb"(?:[\x20-\x7e]|[\xe4-\xe9][\x80-\xbf]{2}|[\xf0][\x80-\xbf]{3}){2,}")
lits = []
for m in pat.finditer(raw):
    try:
        t = m.group().decode("utf-8")
    except Exception:
        continue
    if re.search("[\u4e00-\u9fff]", t):
        lits.append(t)
uniq = sorted(set(lits))
with open(r"F:\qtMusic\qt-pc\tools\binary-literals.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(uniq))
print("二进制中文字面量（去重）:", len(uniq))

text = open(REC, encoding="utf-8").read()
lines = text.split("\n")
print("recovered 行数:", len(lines))

comment_bad, code_bad = [], []
for i, ln in enumerate(lines, 1):
    if "\ufffd" not in ln:
        continue
    stripped = ln.strip()
    if stripped.startswith("//"):
        comment_bad.append(i)
    else:
        code_bad.append(i)

print(f"受损行: 注释 {len(comment_bad)} 行, 代码 {len(code_bad)} 行")
print()
print("===== 受损的代码行（必须精确修复）=====")
for i in code_bad:
    print(f"{i:5}: {lines[i-1]}")
print()
print("===== 受损的注释行行号 =====")
print(comment_bad)
print()
print("===== 可能与上一行粘连的行（含 U+FFFD 且行内有 #[test] 或 { ）=====")
for i, ln in enumerate(lines, 1):
    if "\ufffd" in ln and ("#[test]" in ln or ln.rstrip().endswith("{")):
        print(f"{i:5}: {ln}")