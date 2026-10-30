import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Database, Settings2 } from "lucide-react";
import { getSourceState } from "@/source-scripts/source-update";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT } from "@/services/ipc";
import { disclaimerVisible, useDisclaimerStore } from "@/stores/disclaimer";

/**
 * 「未安装数据包」首页全屏引导（数据包不内置模型）。
 *
 * 数据包（meta 槽）承载搜索/歌单/歌词/封面全部在线数据接口——未装 = 数据面
 * 下线（本地音乐不受影响），仅靠设置页角落的一行状态不足以让用户知道该装；
 * 因此未装时在首页弹全屏引导：
 *
 * - 出现条件：本地状态已读到 && activeMetaId 为空（未装/停用/装载失败清槽都算）
 *   && 本次启动没有主动关过；首次启动引导（/onboarding）进行中不弹，完成后
 *   回到首页自然出现；
 * - 口径与 PlayPackPrompt 一致：只说明「在线能力需要安装数据包」并指路
 *   设置页，**不提及任何官方渠道、不带下载动作**——安装（从链接/本地文件）
 *   完全由用户在设置页发起；安装成功经 source-meta-changed 事件自动关闭；
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
  /** 首次启动的免责声明正在展示时，本引导让位 */
  const disclaimerOpen = useDisclaimerStore(disclaimerVisible);

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
  }, [refresh]);

  // 安装成功/停用/装载失败清槽都会广播；装载成功后这里读到非空即自动关闭
  useTauriEvent(SOURCE_META_CHANGED_EVENT, () => void refresh());
  useTauriEvent(SOURCE_PACK_CHANGED_EVENT, () => void refresh());

  const goSettings = (): void => {
    // 引导是全局浮层：进设置页即让位，装好后经事件自动闭环
    setDismissed(true);
    void navigate({
      to: "/settings/$section",
      params: { section: "source-package" },
    });
  };

  // 首次启动引导（/onboarding）进行中不弹，避免两场引导叠在一起
  if (pathname === "/onboarding") return null;
  // 首次启动的免责声明也在这层浮层里（同一个 z-[60]/z-50 家族）：
  // 全新安装必然没装数据包，两边一起弹就是两份「先读这个」，等声明读完再谈装包
  if (disclaimerOpen) return null;
  if (dismissed || activeMetaId === undefined || activeMetaId !== null) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="mx-4 flex w-full max-w-md flex-col gap-5 rounded-2xl border border-border bg-card/90 p-7 shadow-overlay backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Database className="h-5 w-5 text-primary" />
          </span>
          <div className="flex-1">
            <h2 className="text-base font-semibold">安装数据包，使用在线功能</h2>
            <p className="text-xs text-muted-foreground">搜索 / 歌单 / 歌词 / 封面</p>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          在线搜索、歌单、歌词与封面等功能由数据包提供，应用未内置，需自行安装一次
          （设置页支持从链接或本地文件安装）。未安装不影响本地音乐播放。
        </p>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={goSettings}
            className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Settings2 className="h-4 w-4" />
            去设置页安装
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded-xl px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            暂不安装（仅使用本地音乐，下次启动会再次提醒）
          </button>
        </div>
      </div>
    </div>
  );
}
