"""只读诊断 3：确认那条 local 收藏是不是 PC 自己的本地扫描曲目。"""
import sqlite3

DB = r"C:\Users\canace\AppData\Roaming\QuietMusic\data\music.db"
con = sqlite3.connect("file:" + DB.replace("\\", "/") + "?mode=ro", uri=True)
cur = con.cursor()

path = r"F:\ChromeDownload\F000002nHjMx3JREwF.flac"

print("=" * 74)
print("1) 该路径是否在 PC 的 tracks 表（= PC 本地扫描到的曲目）")
print("=" * 74)
cur.execute("SELECT id, platform, title, singer, missing FROM tracks WHERE id = ?", (f"local:{path}",))
rows = cur.fetchall()
print(rows if rows else "不在 tracks 表")

print()
print("=" * 74)
print("2) tracks 表里 local 曲目的样例（看 id 形态）")
print("=" * 74)
cur.execute("SELECT id, title, missing FROM tracks WHERE platform='local' LIMIT 6")
for r in cur.fetchall():
    print("  ", r)

print()
print("=" * 74)
print("3) liked_songs 里那条 local 行的完整字段")
print("=" * 74)
cur.execute(
    "SELECT id, sid, platform, name, singer, album, hash, pid, updated_seq, created_at "
    "FROM liked_songs WHERE platform='local'"
)
cols = [d[0] for d in cur.description]
for r in cur.fetchall():
    for c, v in zip(cols, r):
        print(f"  {c:14} = {v}")
    print("  " + "-" * 40)

print()
print("=" * 74)
print("4) 模拟 list_favorites(pid='local') 的查询（PC 的 SQL 口径）")
print("=" * 74)
cur.execute(
    """
    SELECT l.sid, l.platform, l.name, l.singer, l.album,
           t.pic_url, t.duration_ms, t.music_id
      FROM liked_songs l
      LEFT JOIN tracks t ON t.id = l.id
     WHERE l.deleted_at IS NULL
       AND l.id IN (SELECT song_id FROM liked_song_playlists WHERE pid = ?)
     ORDER BY l.created_at DESC
    """,
    ("local",),
)
r2 = cur.fetchall()
for r in r2:
    print("  ", r)
print(f"  -> 该歌单按此查询返回 {len(r2)} 首")

con.close()