import { useCallback, useEffect, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { MyPlaylistSummary, SourceId } from "@/types";
import { SOURCE_DISPLAY } from "@/types";
import * as ipc from "@/services/ipc";
import { pullLikes } from "@/stores/auth";
import { qtresCoverUrl } from "@/lib/lrc";

/**
 * 收藏（路由 /favorites，DESIGN §5.3）。
 *
 * 歌单是唯一的组织单位，这里只列歌单、不再单列「收藏的歌」：
 * - `platform === "local"`：本地歌单，点进去看这个歌单收藏的歌
 * - 其余：在线收藏歌单，曲目点开时向音源取
 *
 * 收藏歌曲不再以独立列表呈现，它归属于某个歌单。
 */
export function FavoritesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [list, setList] = useState<MyPlaylistSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // 打开时先把云端收藏拉回来（未登录 / 后端不可达由 pullLikes 内部吞掉）
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

  useEffect(() => {
    void load();
  }, [load]);

  /** 手动同步。这里不吞错误，失败要让用户看得见 */
  const syncNow = async (): Promise<void> => {
    setSyncing(true);
    setError(null);
    try {
      await pullLikes();
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSyncing(false);
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

  const local = list.filter((p) => p.platform === ipc.LOCAL_PLATFORM);
  const online = list.filter((p) => p.platform !== ipc.LOCAL_PLATFORM);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-medium">我的收藏</h1>
          <button
            type="button"
            onClick={() => void syncNow()}
            disabled={syncing}
            className="h-7 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
          >
            {syncing ? "同步中…" : "同步云端收藏"}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          共 {local.length} 个本地歌单 · {online.length} 个在线歌单
        </p>
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
            还没有歌单，在歌单详情页点「收藏」把在线歌单收进来
          </div>
        ) : (
          <>
            <Group
              title="本地歌单"
              items={local}
              onOpen={open}
              onRemove={(p) => void remove(p)}
              removeLabel="删除"
            />
            <Group
              title="收藏的在线歌单"
              items={online}
              onOpen={open}
              onRemove={(p) => void remove(p)}
              removeLabel="取消收藏"
            />
          </>
        )}
      </div>
    </div>
  );
}

function Group(props: {
  title: string;
  items: MyPlaylistSummary[];
  onOpen: (p: MyPlaylistSummary) => void;
  onRemove: (p: MyPlaylistSummary) => void;
  removeLabel: string;
}): React.JSX.Element | null {
  if (props.items.length === 0) return null;

  return (
    <div className="pb-2">
      <h2 className="px-4 pb-1 pt-3 text-xs text-muted-foreground">
        {props.title}
      </h2>
      <ul>
        {props.items.map((p) => {
          const cover = p.platform === ipc.LOCAL_PLATFORM ? "" : qtresCoverUrl(p.picUrl);
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
