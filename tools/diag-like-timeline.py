"""只读诊断 2：收藏的最近时间线 + 平台分布，判断同步是否仍在工作。"""
import sqlite3
from datetime import datetime, timezone, timedelta

DB = r"C:\Users\canace\AppData\Roaming\QuietMusic\data\music.db"
CST = timezone(timedelta(hours=8))
con = sqlite3.connect("file:" + DB.replace("\\", "/") + "?mode=ro", uri=True)
cur = con.cursor()


def ts(ms):
    if ms is None:
        return "-"
    try:
        return datetime.fromtimestamp(ms / 1000, CST).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ms)


print("=" * 78)
print("最近 15 条活跃收藏（按收藏时间倒序）")
print("=" * 78)
cur.execute(
    "SELECT platform, sid, substr(name,1,24), pid, created_at, updated_at "
    "FROM liked_songs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15"
)
print(f"{'platform':9} {'收藏时间(CST)':20} {'更新时间(CST)':20} name")
for plat, sid, name, pid, ca, ua in cur.fetchall():
    print(f"{plat:9} {ts(ca):20} {ts(ua):20} {name}")

print()
print("=" * 78)
print("各平台最新收藏时间")
print("=" * 78)
cur.execute(
    "SELECT platform, COUNT(*), MAX(created_at) FROM liked_songs "
    "WHERE deleted_at IS NULL GROUP BY platform"
)
for plat, n, mx in cur.fetchall():
    print(f"{plat:9} n={n:<4} 最新={ts(mx)}")

print()
print("=" * 78)
print("系统当前时间(CST)")
print("=" * 78)
print(datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"))

con.close()