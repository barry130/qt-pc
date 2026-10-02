import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { CloudDownload, Loader2, Settings2 } from "lucide-react";
import {
  applySourceUpdate,
  discoverSourceUpdates,
  getSourceState,
} from "@/source-scripts/source-update";

/**
 * 「未安装数据包」首页全屏引导（数据包不内置、在线安装模型）。
 *
 * 数据包（meta 槽）承载搜索/歌单/歌词/封面全部在线数据接口——未装 = 数据面
 * 下线（本地音乐不受影响），仅靠设置页角落的一行状态不足以让用户知道该装；
 * 因此未装时在首页弹全屏引导：
 *
 * - 出现条件：本地状态已读到 && activeMetaId 为空（未装/停用/装载失败清槽都算）
 *   && 本次启动没有主动关过；首次启动引导（/onboarding）进行中不弹，完成后
 *   回到首页自然出现；
 * - 主按钮「在线安装官方数据包」：走 discoverSourceUpdates(true) → 取 meta
 *   首装 offer → applySourceUpdate（下载/验签/落盘与设置页同一条管线）；
 *   安装成功即自动上位（生效门：数据槽空）→ Rust 广播 source-meta-changed →
 *   引擎页装载 → 这里监听同一事件刷新状态并自动关闭；
 * - 服务端没有发布 meta 产物/网络失败 → 提示原因，保留「去设置页手动安装」
 *   （设置页支持直链/本地文件安装）；
 * - 「暂不安装」仅本次会话关闭（模块级标记，重启应用会再次引导）——应用
 *   在未装数据包状态下仍可作为本地播放器使用。
 */
export function MetaPackGuide(): React.JSX.Element | null {
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  /** undefined = 还没读到本地状态（首帧不弹，避免闪烁） */
  const [activeMetaId, setActiveMetaId] = useState<string | null | undefined>(undefined);
  /** 本会话已主动关闭（重启应用后重新引导） */
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  /** 防重复点击（installing 之外的兜底） */
  const startedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const state = await getSourceState();
      setActiveMetaId(state.activeMetaId);
    } catch {
      // 读不到状态保持 undefined（不弹也不误关）
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 安装成功/停用/装载失败清槽都会广播；装载成功后这里读到非空即自动关闭
    const unlisteners: (() => void)[] = [];
    void listen("source-meta-changed", () => void refresh()).then((u) =>
      unlisteners.push(u),
    );
    void listen("source-pack-changed", () => void refresh()).then((u) =>
      unlisteners.push(u),
    );
    return () => unlisteners.forEach((u) => u());
  }, [refresh]);

  /** 在线安装官方数据包：发现 → meta 首装 offer → 应用（成功后经事件自动关闭） */
  const installOfficial = async (): Promise<void> => {
    if (installing || startedRef.current) return;
    startedRef.current = true;
    setInstalling(true);
    setError("");
    try {
      const result = await discoverSourceUpdates(true);
      const offer = result.offers.find((o) => o.kind === "meta");
      if (!offer) {
        setError("暂未发现可安装的数据包（官方渠道尚未发布或网络不可用），可稍后重试或去设置页手动安装");
        return;
      }
      try {
        await applySourceUpdate(offer);
        // 成功路径：生效门自动上位 → source-meta-changed → refresh 关闭引导。
        // 再补一次刷新兜底（广播丢失/槽位被占未激活等边缘情况）。
        await refresh();
      } catch (e) {
        setError(`安装失败：${String(e)}（可去设置页手动安装）`);
      }
    } catch {
      setError("更新发现失败（网络不可用），可稍后重试或去设置页手动安装");
    } finally {
      setInstalling(false);
      startedRef.current = false;
    }
  };

  const goSettings = (): void => {
    setDismissed(true);
    void navigate({
      to: "/settings/$section",
      params: { section: "source-package" },
    });
  };

  // 首次启动引导（/onboarding）进行中不弹，避免两场引导叠在一起
  if (pathname === "/onboarding") return null;
  if (dismissed || activeMetaId === undefined || activeMetaId !== null) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="mx-4 flex w-full max-w-md flex-col gap-5 rounded-2xl border border-border bg-card p-7 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <CloudDownload className="h-5 w-5 text-primary" />
          </span>
          <div className="flex-1">
            <h2 className="text-base font-semibold">安装数据包，解锁在线音乐</h2>
            <p className="text-xs text-muted-foreground">官方数据包 · 在线安装</p>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          数据包提供搜索、歌单、歌词与封面等在线能力，不随应用内置，需要联网安装一次。
          未安装不影响本地音乐播放。
        </p>

        {error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void installOfficial()}
            disabled={installing}
            className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {installing && <Loader2 className="h-4 w-4 animate-spin" />}
            {installing ? "正在安装…" : "在线安装官方数据包（推荐）"}
          </button>
          <button
            type="button"
            onClick={goSettings}
            disabled={installing}
            className="flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Settings2 className="h-4 w-4" />
            去设置页手动安装（直链 / 本地文件）
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={installing}
            className="rounded-xl px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            暂不安装（仅使用本地音乐，下次启动会再次提醒）
          </button>
        </div>
      </div>
    </div>
  );
}
