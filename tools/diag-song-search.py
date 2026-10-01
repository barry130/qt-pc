"""只读诊断 4：查「人生路慢慢」在 PC 库里的踪迹，并对比「也许」。"""
import sqlite3

DB = r"C:\Users\canace\AppData\Roaming\QuietMusic\data\music.db"
con = sqlite3.connect("file:" + DB.replace("\\", "/") + "?mode=ro", uri=True)
cur = con.cursor()

for kw in ("人生路慢慢", "也许"):
    print("=" * 74)
    print(f"关键词：{kw}")
    print("=" * 74)
    cur.execute(
        "SELECT id, sid, platform, name, singer, pid, deleted_at IS NULL AS alive, updated_seq "
        "FROM liked_songs WHERE name LIKE ?",
        (f"%{kw}%",),
    )
    rows = cur.fetchall()
    if not rows:
        print("  liked_songs 中不存在")
    for r in rows:
        print("  ", r)
    cur.execute("SELECT id, title, platform FROM tracks WHERE title LIKE ?", (f"%{kw}%",))
    t = cur.fetchall()
    print("  tracks:", t if t else "不存在")
    print()

print("=" * 74)
print("liked_songs 全部行（含已删）")
print("=" * 74)
cur.execute(
    "SELECT platform, sid, name, pid, deleted_at FROM liked_songs ORDER BY platform, name"
)
for r in cur.fetchall():
    print("  ", r)

con.close()