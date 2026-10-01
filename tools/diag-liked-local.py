"""只读诊断：检查 PC 收藏库里是否有 platform=local 的云端歌曲。
绝不写库（mode=ro）。"""
import sqlite3
import sys

DB = r"C:\Users\canace\AppData\Roaming\QuietMusic\data\music.db"
uri = "file:" + DB.replace("\\", "/") + "?mode=ro"
con = sqlite3.connect(uri, uri=True)
cur = con.cursor()


def show(title, sql, args=()):
    print("=" * 70)
    print(title)
    print("-" * 70)
    try:
        cur.execute(sql, args)
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
        print(" | ".join(cols))
        for r in rows:
            print(" | ".join("" if v is None else str(v) for v in r))
        print(f"({len(rows)} rows)")
    except Exception as e:
        print("ERR:", e)


show(
    "1) liked_songs 按 platform 分组",
    "SELECT platform, COUNT(*) AS n, SUM(deleted_at IS NULL) AS alive "
    "FROM liked_songs GROUP BY platform ORDER BY n DESC",
)

show(
    "2) 活跃收藏里 platform=local 的行（PC 自己的本地曲目收藏）",
    "SELECT sid, platform, name, singer, pid, deleted_at IS NULL AS alive, created_at "
    "FROM liked_songs WHERE platform='local' ORDER BY created_at DESC LIMIT 30",
)

show(
    "3) 收藏歌单卡片 liked_playlists",
    "SELECT pid, platform, name, deleted_at FROM liked_playlists ORDER BY created_at DESC",
)

show(
    "4) 本地 playlists 表",
    "SELECT id, pid, name FROM playlists ORDER BY created_at DESC",
)

show(
    "5) 多归属关联表 cared：platform=local 的关联",
    "SELECT ls.song_id, ls.pid, l.name, ls.added_at "
    "FROM liked_song_playlists ls LEFT JOIN liked_songs l ON l.id = ls.song_id "
    "WHERE ls.song_id LIKE 'local:%' ORDER BY ls.added_at DESC LIMIT 30",
)

show(
    "6) 同步状态 settings",
    "SELECT key, value FROM settings WHERE key LIKE 'like%'",
)

show(
    "7) 待重放离线队列",
    "SELECT type, action, payload_json, retry_count FROM pending_like_ops LIMIT 20",
)

show(
    "8) tracks 表里 platform=local 的行数（本地扫描入库）",
    "SELECT COUNT(*) FROM tracks WHERE platform='local'",
)

con.close()
print("\n(只读查询完成，未修改任何数据)")