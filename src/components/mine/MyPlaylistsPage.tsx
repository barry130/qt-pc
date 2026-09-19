import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { MyPlaylistSummary, SourceId } from "@/types";
import { SOURCE_DISPLAY } from "@/types";
import * as ipc from "@/services/ipc";
import { pullLikes } from "@/stores/auth";
import { qtresCoverUrl } from "@/lib/lrc";
import { ImportPlaylistDialog } from "./ImportPlaylistDialog";

/**
 * 我的歌单（路由 /my/playlists，DESIGN §5.3）。
 *
 * 歌单是唯一的组织单位，`platform` 区分两种来源：
 * - `"local"`：本地自建，曲目就是挂在它 pid 下的收藏（liked_songs.pid）
 * - 其余（qq / wyy / kw / kg）：在线音源收藏的，曲目点开时才向音源取
 *
 * 两类的操作也不同：在线歌单不能重命名（名字归音源所有），
 * 「移除」的语义是**取消收藏**，不是删除；「我喜欢的歌曲」
 * 既不能改名也不能删 —— 散装收藏要靠它落脚。
 */
export function MyPlaylistsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [list, setList] = useState<MyPlaylistSummary[]>([]);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      // 打开时先把云端收藏拉回来（未登录 / 后端不可达由 pullLikes 内部吞掉），
      // 别端的建单/删单/改名才能反映到这个列表 —— 对齐 FavoritesPage
      await pullLikes().catch(() => {});
      const l = await ipc
        .listMyPlaylists()
        .catch(() => [] as MyPlaylistSummary[]);
      setList(Array.isArray(l) ? l : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    try {
      await ipc.createPlaylist(n);
      setName("");
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const saveRename = async (id: string): Promise<void> => {
    const n = editName.trim();
    if (!n) {
      setEditingId(null);
      return;
    }
    setError(null);
    try {
      await ipc.renamePlaylist(id, n);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  /** 移除：自建歌单是删除（按 pid），云端卡片歌单是取消收藏（不动歌） */
  const remove = async (p: MyPlaylistSummary): Promise<void> => {
    setError(null);
    try {
      if (p.isLocal) {
        await ipc.deletePlaylist(p.pid);
      } else {
        await ipc.unfavoritePlaylist(p.platform, p.pid, p.name, p.picUrl);
      }
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const open = (p: MyPlaylistSummary): void => {
    if (p.platform === ipc.LOCAL_PLATFORM) {
      // 本地歌单按永久 pid 查询（本歌单只展示归属自己的收藏歌曲）
      void navigate({ to: "/my/playlist/$id", params: { id: p.pid } });
    } else {
      void navigate({
        to: "/playlist/$platform/$id",
        params: { platform: p.platform, id: p.id },
      });
    }
  };

  /** 导入完成：刷新列表并跳到该歌单详情（与移动端导入后跳转一致） */
  const onImported = (playlist: { id: string; platform: string }): void => {
    setImportOpen(false);
    void load();
    void navigate({
      to: "/playlist/$platform/$id",
      params: { platform: playlist.platform, id: playlist.id },
    });
  };

  const local = list.filter((p) => p.platform === ipc.LOCAL_PLATFORM);
  const online = list.filter((p) => p.platform !== ipc.LOCAL_PLATFORM);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">我的歌单</h1>
        <div className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
            placeholder="新建歌单名称"
            className="h-8 flex-1 rounded-md border border-input bg-background px-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={!name.trim()}
            className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            新建
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="h-8 shrink-0 rounded-md border border-border px-3 text-xs hover:bg-accent"
          >
            导入
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="p-6 text-center text-sm text-destructive">
            操作失败：{error}
          </div>
        )}
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : !error && list.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            还没有歌单。可以新建一个，或在歌单详情页收藏在线歌单
          </div>
        ) : (
          <>
            <Group
              title="本地歌单"
              items={local}
              emptyHint="还没有自建歌单，上面新建一个吧"
              editingId={editingId}
              editName={editName}
              setEditName={setEditName}
              onOpen={open}
              onStartRename={(p) => {
                setEditingId(p.pid);
                setEditName(p.name);
              }}
              onSaveRename={(id) => void saveRename(id)}
              onCancelRename={() => setEditingId(null)}
              onRemove={(p) => void remove(p)}
              removeLabel="删除"
            />
            <Group
              title="收藏的在线歌单"
              items={online}
              emptyHint="还没有收藏在线歌单，点上方「导入」粘贴分享链接，或在歌单详情页点「收藏」"
              editingId={editingId}
              editName={editName}
              setEditName={setEditName}
              onOpen={open}
              onStartRename={() => {}}
              onSaveRename={() => {}}
              onCancelRename={() => setEditingId(null)}
              onRemove={(p) => void remove(p)}
              removeLabel="取消收藏"
              hideRename
            />
          </>
        )}
      </div>
      {importOpen && (
        <ImportPlaylistDialog
          onClose={() => setImportOpen(false)}
          onImported={onImported}
        />
      )}
    </div>
  );
}

function Group(props: {
  title: string;
  items: MyPlaylistSummary[];
  emptyHint: string;
  editingId: string | null;
  editName: string;
  setEditName: (v: string) => void;
  onOpen: (p: MyPlaylistSummary) => void;
  onStartRename: (p: MyPlaylistSummary) => void;
  onSaveRename: (id: string) => void;
  onCancelRename: () => void;
  onRemove: (p: MyPlaylistSummary) => void;
  removeLabel: string;
  /** 云端卡片歌单不可改名（名字归云端/音源所有） */
  hideRename?: boolean;
}): React.JSX.Element | null {
  if (props.items.length === 0) return null;

  return (
    <div className="pb-2">
      <h2 className="px-4 pb-1 pt-3 text-xs text-muted-foreground">
        {props.title}
      </h2>
      <ul>
        {props.items.map((p) => {
          const cover =
            p.platform === ipc.LOCAL_PLATFORM ? "" : qtresCoverUrl(p.picUrl);
          return (
            <li
              key={`${p.platform}:${p.pid}`}
              className="flex items-center gap-3 border-b border-border/50 px-4 py-2"
            >
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded bg-secondary" />
              )}

              {props.editingId === p.pid ? (
                <input
                  autoFocus
                  value={props.editName}
                  onChange={(e) => props.setEditName(e.target.value)}
                  onBlur={props.onSaveRename.bind(null, p.pid)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") props.onSaveRename(p.pid);
                    if (e.key === "Escape") props.onCancelRename();
                  }}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => props.onOpen(p)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-sm">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.platform === ipc.LOCAL_PLATFORM
                      ? `${p.trackCount} 首`
                      : `在线 · ${
                          SOURCE_DISPLAY[p.platform as Exclude<SourceId, "local">] ??
                          p.platform
                        }`}
                  </div>
                </button>
              )}

              {!props.hideRename && (
                <button
                  type="button"
                  onClick={() => props.onStartRename(p)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  重命名
                </button>
              )}
              <button
                type="button"
                onClick={() => props.onRemove(p)}
                className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
              >
                {props.removeLabel}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
