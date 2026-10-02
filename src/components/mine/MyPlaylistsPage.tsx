import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { MyPlaylistSummary } from "@/types";
import { useSourceLabelFn } from "@/stores/sourceRegistry";
import * as ipc from "@/services/ipc";
import { pullLikes } from "@/stores/auth";
import { qtresCoverUrl } from "@/lib/lrc";
import { ImportPlaylistDialog } from "./ImportPlaylistDialog";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";

/**
 * 我的歌单（路由 /my/playlists，DESIGN §5.3）——「我的歌单」与「收藏」已合成一页。
 *
 * 歌单是唯一的组织单位，`platform` 区分两种来源：
 * - `"local"`：本地自建，曲目就是挂在它 pid 下的收藏（liked_songs.pid）
 * - 其余（qq / wyy / kw / kg）：在线音源收藏的，曲目点开时才向音源取
 *
 * 两类的操作也不同：在线歌单不能重命名（名字归音源所有），
 * 「移除」的语义是**取消收藏**，不是删除；「我喜欢的歌曲」
 * 既不能改名也不能删 —— 散装收藏要靠它落脚。
 *
 * 建单 / 导入 / 重命名 / 本地歌单换封面都在这一页，不再拆成两个页面。
 * 云端收藏在打开本页时自动拉取（pullLikes），不提供手动同步入口。
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
    setError(null);
    try {
      // 打开时先把云端收藏拉回来（未登录 / 后端不可达由 pullLikes 内部吞掉），
      // 别端的建单/删单/改名才能反映到这个列表
      await pullLikes().catch(() => {});
      // 这里**不吞**错误：读不到歌单时要让用户看见原因，
      // 否则一律显示空态，分不清是「真没有」还是「读失败」
      const l = await ipc.listMyPlaylists();
      setList(Array.isArray(l) ? l : []);
    } catch (err) {
      setError(errMsg(err));
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 本页常驻缓存（挂载后不再卸载）：只在首次挂载拉数据的话，别端的建单/删单/改名
  // 永远反映不过来，与上面「打开本页时自动拉取」的说明也不一致。改为每次切回来重拉。
  const active = useKeepAliveActive();

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

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

  /** 导入歌曲完成：刷新列表并跳到目标我方歌单详情（歌曲整单拷入模式） */
  const onSongsImported = (pid: string): void => {
    setImportOpen(false);
    void load();
    void navigate({ to: "/my/playlist/$id", params: { id: pid } });
  };

  /**
   * 换本地歌单封面：选图 → Rust 复制进应用数据目录 → 登记 cover_path。
   * 成功后本页乐观替换 picUrl（即新封面路径），下次读列表以本地库为准。
   * 仅本地自建歌单可换；在线歌单封面归音源/云端所有，不提供入口。
   */
  const changeCover = async (p: MyPlaylistSummary): Promise<void> => {
    const path = await ipc.pickImage("选择歌单封面");
    if (!path) return;
    setError(null);
    try {
      const coverPath = await ipc.setPlaylistCover(p.pid, path);
      setList((prev) =>
        prev.map((it) =>
          it.platform === ipc.LOCAL_PLATFORM && it.pid === p.pid
            ? { ...it, picUrl: coverPath }
            : it,
        ),
      );
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const local = list.filter((p) => p.platform === ipc.LOCAL_PLATFORM);
  const online = list.filter((p) => p.platform !== ipc.LOCAL_PLATFORM);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">我的歌单</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          共 {local.length} 个本地歌单 · {online.length} 个在线歌单
        </p>
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
            还没有歌单。可以新建一个，或点上方「导入」粘贴分享链接，
            也可以在歌单详情页点「收藏」
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
              onChangeCover={(p) => void changeCover(p)}
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
          onSongsImported={onSongsImported}
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
  /** 本地自建歌单换封面；不传则不显示入口（在线歌单封面归音源/云端所有） */
  onChangeCover?: (p: MyPlaylistSummary) => void;
}): React.JSX.Element {
  // 在线歌单的源展示名走数据包注册表（stores/sourceRegistry）
  const sourceLabel = useSourceLabelFn();
  return (
    <div className="pb-2">
      <h2 className="px-4 pb-1 pt-3 text-xs text-muted-foreground">
        {props.title}
      </h2>
      {/* 空分组也保留标题与引导：另一组有内容时，这组空着要说得清为什么 */}
      {props.items.length === 0 ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">{props.emptyHint}</p>
      ) : (
        <ul>
        {props.items.map((p) => {
          return (
            <li
              key={`${p.platform}:${p.pid}`}
              className="flex items-center gap-3 border-b border-border/50 px-4 py-2"
            >
              <PlaylistCoverImage p={p} />

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
                      : `在线 · ${sourceLabel(p.platform)}`}
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
              {/* 换封面只给本地自建歌单（云端卡片「我喜欢的歌曲」与在线歌单都不给） */}
              {props.onChangeCover && p.isLocal && (
                <button
                  type="button"
                  onClick={() => props.onChangeCover?.(p)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  换封面
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
      )}
    </div>
  );
}

/**
 * 歌单封面图：在线歌单走 qtres 代取；本地歌单按 pid 异步读封面文件
 * （Rust 转成 data URL，模块级按 pid 缓存），没有自设封面回退默认图。
 */
const localCoverCache = new Map<string, string | null>();

function PlaylistCoverImage({ p }: { p: MyPlaylistSummary }): React.JSX.Element {
  const isLocal = p.platform === ipc.LOCAL_PLATFORM;
  const onlineUrl = isLocal ? null : qtresCoverUrl(p.picUrl);
  const [localSrc, setLocalSrc] = useState<string | null>(
    isLocal ? (localCoverCache.get(p.pid) ?? null) : null,
  );

  useEffect(() => {
    if (!isLocal || !p.picUrl) return;
    if (localCoverCache.has(p.pid)) {
      setLocalSrc(localCoverCache.get(p.pid) ?? null);
      return;
    }
    let alive = true;
    void ipc
      .getPlaylistCover(p.pid)
      .then((v) => {
        localCoverCache.set(p.pid, v);
        if (alive) setLocalSrc(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isLocal, p.pid, p.picUrl]);

  const src = isLocal ? localSrc : onlineUrl;
  if (!src) {
    return (
      <img
        src="/static/icon/xxxhdpi.png"
        alt=""
        className="h-10 w-10 shrink-0 rounded object-cover"
        draggable={false}
      />
    );
  }
  return <img src={src} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />;
}
