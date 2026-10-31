import { useCallback, useEffect, useRef, useState } from "react";
import { useOfficialSiteUrl } from "@/hooks/useOfficialSiteUrl";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { readAggregateSources, saveAggregateSources } from "@/lib/aggregate-sources";
import { OFFICIAL_SOURCE_SETUP_PATH, officialSitePath } from "@/lib/official-site";
import { stripErrorUrls } from "@/lib/utils";
import { SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT } from "@/services/ipc";
import { activateSourcePack, applySourceUpdate, discoverSourceUpdates, getSourceState, installSourceLabel, installStagedSource, isPackLinkUrl, kindLabel, lastErrorSummary, offerLabel, packDisplayName, packVersionLabel, shortUpdateDate, stageSourceFromFile, stageSourceFromUrl, uninstallSourcePack, type PackPreviewVo, type SourcePackVo } from "@/source-scripts/source-update";
import { useSourceUpdateStore } from "@/stores/source-update";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import { toast, toastError, toastSuccess } from "@/stores/toast";
import { ExternalLinkButton, SettingRow, Switch } from "../controls";
import { Button, Modal } from "@/components/ui";
import { SourceAccountSection } from "./SourceAccountSection";
import { buttonClass } from "@/components/ui";

export function packLabel(p: SourcePackVo): string {
  return `${packDisplayName(p)} · ${packVersionLabel(p)} (code ${p.versionCode})`;
}

/** 卸载按钮的「两击确认」状态：null = 未武装；否则记录包 id 与计时器 */
type ArmedUninstall = { packId: string; timer: number };

/** 本会话已提示过的剪贴板链接（同一链接只提示一次，忽略/安装都算） */
const PROMPTED_CLIPBOARD_LINKS = new Set<string>();

/**
 * 聚合搜索音源（设置 → 音源包）：勾哪几个源，聚合类搜索就只查这几个。
 *
 * 「聚合」= 一次搜索同时打多个源：搜索页「全部音源」分组、AI 找歌的候选池、手动换源、
 * 每日推荐的跨源补充。**单源搜索不受影响**（搜索页某个源的页签、榜单、歌单、歌手页
 * 用的都是用户当前选中的那个源，与这里无关）。
 *
 * 关掉的源在数据包侧就**不发请求**（`searchAll`/`searchMany` 的可选 `sources` 入参），
 * 不是搜完再把结果丢掉 —— 少一个源就真的少一份往返、少一条超时线，聚合搜索结果也
 * 不会被用户不想用的源污染。
 *
 * 存的是源 id 数组；「全选」写成空值（= 全部），这样以后数据包新增音源时会自动参与，
 * 而不是被一份旧的白名单永久排除在外。
 *
 * 导出只为单测能直接挂这一个设置行（整页要有音源包/更新/剪贴板一堆依赖）。
 */
export function AggregateSourcesRow(): React.JSX.Element {
  const sources = useSourceRegistryStore((s) => s.sources);
  const ensure = useSourceRegistryStore((s) => s.ensure);
  /** null = 全部音源（还没配置过，或用户点回了全选） */
  const [selected, setSelected] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 写入串行队列：连点时按钮立刻响应，但落库顺序不会乱（后写的必须是后点的那次） */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void ensure();
    void (async () => {
      setSelected(await readAggregateSources());
      setLoaded(true);
    })();
  }, [ensure]);

  const allIds = sources.map((item) => item.id);
  // 只有注册表里真实存在的源可勾选；设置里残留的已卸载源 id 原样留在配置里
  // （重新装包后自动恢复），但不参与这里的开关显示
  const enabledIds =
    selected === null ? allIds : allIds.filter((id) => selected.includes(id));
  const enabledCount = enabledIds.length;

  const toggle = (id: string): void => {
    if (!loaded) return;
    const next = enabledIds.includes(id)
      ? enabledIds.filter((item) => item !== id)
      : allIds.filter((item) => enabledIds.includes(item) || item === id);
    if (next.length === 0) {
      // 一个都不选 = 聚合搜索永远空结果，直接拦在 UI 上（数据侧也把空数组当「全部」）
      toast("至少留一个音源，否则聚合搜索不会有结果");
      return;
    }
    const allSelected = next.length === allIds.length;
    // 先乐观更新：连点两个开关不该丢第二个点击（落库是串行的，写失败再提示）
    setSelected(allSelected ? null : next);
    saveQueue.current = saveQueue.current
      .then(() => saveAggregateSources(allSelected ? [] : next))
      .catch((e) => {
        toastError(`保存失败：${stripErrorUrls(String(e))}`);
      });
  };

  return (
    <SettingRow
      title="聚合搜索音源"
      description={
        allIds.length === 0
          ? "搜索页「全部音源」、AI 找歌、手动换源、每日推荐跨源共用这份选择；单源搜索（某个源的页签、榜单、歌单、歌手页）不受影响。"
          : `搜索页「全部音源」、AI 找歌、手动换源、每日推荐跨源只查勾选的源（已选 ${enabledCount}/${allIds.length}）；关掉的源不再被请求。单源搜索不受影响；新装的音源默认不参与，需要在这里打开。`
      }
    >
      <div className="flex w-full flex-col gap-1.5">
        {allIds.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {loaded ? "音源引擎未就绪，暂时读不到音源清单" : "正在读取音源清单…"}
          </span>
        )}
        {sources.map((item) => (
          <div key={item.id} className="flex w-full items-center justify-end gap-2">
            <span className="flex-1 text-right text-xs text-muted-foreground">
              {item.name}
            </span>
            <Switch
              checked={enabledIds.includes(item.id)}
              onToggle={() => toggle(item.id)}
            />
          </div>
        ))}
      </div>
    </SettingRow>
  );
}

/** 音源账号（v9 数据包）：扫码登录 B 站/网易等音源账号；凭据只存本机，
 *  「数据请求/播放请求是否使用登录态」两面开关**按源独立**。管理界面已
 *  独立成「音源账号」页（侧边栏「我的」组、我的歌单下方，/source-accounts），
 *  设置页只留跳转入口。 */

export function SourcePackageSection(): React.JSX.Element {
  const local = useSourceUpdateStore((s) => s.local);
  const offers = useSourceUpdateStore((s) => s.offers);
  const busy = useSourceUpdateStore((s) => s.busy);
  const setBusy = useSourceUpdateStore((s) => s.setBusy);
  const setLocal = useSourceUpdateStore((s) => s.setLocal);
  const setOffers = useSourceUpdateStore((s) => s.setOffers);
  const dropOffer = useSourceUpdateStore((s) => s.dropOffer);
  const [url, setUrl] = useState("");
  /** 安装入口模式：从链接 / 从本地文件（同一条设置行内切换） */
  const [installMode, setInstallMode] = useState<"url" | "file">("url");
  const [installing, setInstalling] = useState(false);
  const [armed, setArmed] = useState<ArmedUninstall | null>(null);
  /** 安装预览现场（非 null = 预览确认弹窗开着） */
  const [preview, setPreview] = useState<PackPreviewVo | null>(null);
  /** 预览确认后的落盘安装中 */
  const [confirming, setConfirming] = useState(false);
  /** 剪贴板检测到的音源包链接（非 null = 询问弹窗开着） */
  const [clipTip, setClipTip] = useState<string | null>(null);
  /** 官网根地址（未配置时为空串 → 教程入口整行不渲染） */
  const siteUrl = useOfficialSiteUrl();

  const refresh = useCallback(async () => {
    try {
      setLocal(await getSourceState());
    } catch {
      // 状态读取失败保持旧值（设置页其余操作仍可用）
    }
  }, [setLocal]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Rust 侧包变化（安装/切换/卸载/回滚，含引擎 describe 回填）时同步列表
  useTauriEvent(SOURCE_PACK_CHANGED_EVENT, () => void refresh());
  useTauriEvent(SOURCE_META_CHANGED_EVENT, () => void refresh());

  // 武装态在组件卸载时清理计时器（3 秒自动解除在事件回调里做）
  useEffect(
    () => () => {
      if (armed?.timer) window.clearTimeout(armed.timer);
    },
    [armed],
  );

  // 剪贴板链接检测：设置页音源包区挂载 / 窗口重新聚焦时读一次剪贴板，
  // 是「https … .js」直链且本会话没提示过 → 询问是否安装（确认后仍走预览）。
  // WebView2 未聚焦/无权限时 readText 会 reject，静默降级不打扰。
  const clipboardBusy = installing || confirming || busy;
  useEffect(() => {
    let disposed = false;
    const checkClipboard = (): void => {
      if (disposed || clipboardBusy || preview || clipTip !== null) return;
      void (async () => {
        // try 成功路径赋值、catch 直接 return：两条路径都不需要声明处的初值
        let text: string;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          return; // 读不到（未聚焦/权限）就当没有
        }
        const link = text.trim();
        if (
          disposed ||
          clipboardBusy ||
          preview ||
          clipTip !== null ||
          !isPackLinkUrl(link) ||
          PROMPTED_CLIPBOARD_LINKS.has(link)
        ) {
          return;
        }
        PROMPTED_CLIPBOARD_LINKS.add(link);
        if (!disposed) setClipTip(link);
      })();
    };
    checkClipboard();
    window.addEventListener("focus", checkClipboard);
    return () => {
      disposed = true;
      window.removeEventListener("focus", checkClipboard);
    };
  }, [clipboardBusy, preview, clipTip]);

  /**
   * 动作回执按性质分流后走右上角 Toast：动词开头（已切换/已安装/已卸载…）
   * 是成功回执给绿勾；「已是最新 / 发现 N 个 / 再点一次」这类中性提示走
   * 普通样式，不打断也不需要在页面里停留。
   */
  const report = (text: string): void => {
    if (text.startsWith("已") || text.includes("已安装")) {
      toastSuccess(text);
    } else {
      toast(text);
    }
  };

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      report(await action());
    } catch (e) {
      toastError(`操作失败：${stripErrorUrls(String(e))}`);
    } finally {
      setBusy(false);
    }
  };

  /** 手动检查（force=true 越过 4h/包 探测节流；发现不自动安装） */
  const check = async (): Promise<string> => {
    const result = await discoverSourceUpdates(true);
    setOffers(result.offers);
    await refresh();
    if (!result.offers.length) return "已是最新（没有可用更新）";
    return `发现 ${result.offers.length} 个可用更新，逐条确认后应用`;
  };

  /** 应用单条更新 offer（失败 Rust 自动回滚并拉黑该版本，这里只需提示） */
  const apply = async (index: number): Promise<string> => {
    const offer = offers[index];
    if (!offer) return "没有可用更新";
    const outcome = await applySourceUpdate(offer);
    dropOffer(offer.targetId, offer.kind);
    await refresh();
    return `${kindLabel(outcome.kind)}已更新到 v${outcome.pack.versionCode}（${outcome.pack.name}）`;
  };

  /** 启用包 / 停用数据槽（packId 空串 + kind=meta = 停用数据包，数据面下线） */
  const activate = async (
    packId: string,
    kind: "meta" | "play",
  ): Promise<string> => {
    await activateSourcePack(packId, kind);
    await refresh();
    if (kind === "meta") {
      return packId ? "已切换生效数据包" : "已停用数据包（在线数据不可用）";
    }
    return "已切换生效播放包";
  };

  /** 两击确认的卸载：第一击武装（3 秒内再点确认），第二击执行 */
  const uninstall = async (pack: SourcePackVo): Promise<string> => {
    if (armed?.packId !== pack.id) {
      if (armed?.timer) window.clearTimeout(armed.timer);
      setArmed({
        packId: pack.id,
        timer: window.setTimeout(() => setArmed(null), 3000),
      });
      return "再点一次确认卸载";
    }
    if (armed.timer) window.clearTimeout(armed.timer);
    setArmed(null);
    const wasActivePlay = pack.kind === "play" && local?.activeId === pack.id;
    await uninstallSourcePack(pack.id);
    await refresh();
    return wasActivePlay
      ? "已卸载播放包（在线播放将不可用，可重新安装）"
      : `已卸载${kindLabel(pack.kind)}`;
  };

  /** 预览安装第一步：拉全文+静态校验，把预览信息交给确认弹窗（不落盘） */
  const stageFromLink = (link: string): void => {
    if (busy || installing || confirming || preview) return;
    setInstalling(true);
    void (async () => {
      try {
        setPreview(await stageSourceFromUrl(link));
      } catch (e) {
        toastError(`获取包信息失败：${stripErrorUrls(String(e))}`);
      } finally {
        setInstalling(false);
      }
    })();
  };

  const installUrl = (): void => {
    const trimmed = url.trim();
    if (!trimmed) {
      // 按钮在链接为空时本来就是 disabled，这里只是兜底
      toast("请先粘贴音源包 .js 直链");
      return;
    }
    stageFromLink(trimmed);
  };

  const installLocal = (): void => {
    if (busy || installing || confirming || preview) return;
    setInstalling(true);
    void (async () => {
      try {
        const staged = await stageSourceFromFile();
        // staged 为 null = 用户取消了选择框，不打扰
        if (staged) setPreview(staged);
      } catch (e) {
        toastError(`获取包信息失败：${stripErrorUrls(String(e))}`);
      } finally {
        setInstalling(false);
      }
    })();
  };

  /** 预览确认：按一次性 token 落盘安装（官方 id 冒充警示已在弹窗给过） */
  const confirmInstall = (): void => {
    const staged = preview;
    if (!staged || confirming) return;
    setConfirming(true);
    void (async () => {
      try {
        const outcome = await installStagedSource(staged.token);
        setPreview(null);
        setUrl("");
        await refresh();
        toastSuccess(
          `${kindLabel(outcome.kind)}已安装${outcome.activated ? "并生效" : "，列表中可启用"}`,
        );
      } catch (e) {
        setPreview(null);
        toastError(`安装失败：${stripErrorUrls(String(e))}`);
      } finally {
        setConfirming(false);
      }
    })();
  };

  const packs = local?.packs ?? [];
  const metaPacks = packs.filter((p) => p.kind === "meta");
  const playPacks = packs.filter((p) => p.kind === "play");
  const activeMeta = metaPacks.find((p) => p.id === local?.activeMetaId) ?? null;
  const activePlay = playPacks.find((p) => p.id === local?.activeId) ?? null;
  const metaStatus = activeMeta
    ? packLabel(activeMeta)
    : "未安装（在线搜索/歌单不可用）";
  const playStatus = activePlay
    ? packLabel(activePlay)
    : "未安装（在线播放不可用）";

  return (
    <div className="max-w-4xl divide-y divide-border">
      <SettingRow
        title="数据包"
        description="搜索/歌单/歌词/封面等数据源。不随应用分发，可从链接或本地文件安装。"
      >
        <span className="font-mono text-xs text-muted-foreground">{metaStatus}</span>
      </SettingRow>
      <SettingRow
        title="播放包"
        description="在线播放（取链）必需；高风险源不随应用分发，由用户自行安装。"
      >
        <span className="font-mono text-xs text-muted-foreground">{playStatus}</span>
      </SettingRow>
      <SourceAccountSection />
      <SettingRow
        title="已安装的音源包"
        description={`共 ${packs.length} 个（数据 ${metaPacks.length} / 播放 ${playPacks.length}）。启用即热切换；卸载两击确认。`}
      >
        <div className="flex w-full flex-col gap-2">
          {packs.length === 0 && (
            <span className="text-xs text-muted-foreground">
              还没有安装任何音源包（在线搜索/歌单不可用，本地音乐不受影响）
            </span>
          )}
          {metaPacks.length > 0 && (
            <span className="text-2xs font-medium text-muted-foreground">数据包</span>
          )}
          {metaPacks.map((p) => (
            <PackRow
              key={p.id}
              pack={p}
              radioName="active-meta-pack"
              checked={local?.activeMetaId === p.id}
              busy={busy}
              armed={armed?.packId === p.id}
              onActivate={() => void run(() => activate(p.id, "meta"))}
              onUninstall={() => void run(() => uninstall(p))}
            />
          ))}
          {metaPacks.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="active-meta-pack"
                aria-label="停用数据包"
                checked={!local?.activeMetaId}
                onChange={() => void run(() => activate("", "meta"))}
                disabled={busy}
              />
              <span className="flex-1 font-mono text-muted-foreground">
                停用数据包（在线搜索/歌单不可用）
              </span>
            </div>
          )}
          {playPacks.length > 0 && (
            <span className="mt-1 text-2xs font-medium text-muted-foreground">
              播放包
            </span>
          )}
          {playPacks.map((p) => (
            <PackRow
              key={p.id}
              pack={p}
              radioName="active-play-pack"
              checked={local?.activeId === p.id}
              busy={busy}
              armed={armed?.packId === p.id}
              onActivate={() => void run(() => activate(p.id, "play"))}
              onUninstall={() => void run(() => uninstall(p))}
            />
          ))}
        </div>
      </SettingRow>
      <AggregateSourcesRow />
      <SettingRow
        title="可用更新"
        description="更新只提示不自动安装；应用失败会自动回滚到原版本并跳过该版本。"
      >
        <div className="flex w-full flex-col items-end gap-2">
          {offers.length === 0 ? (
            <span className="text-xs text-muted-foreground">暂无可用更新</span>
          ) : (
            offers.map((o, i) => (
              <div
                key={`${o.kind}:${o.targetId}`}
                className="flex w-full items-center gap-2"
              >
                <span className="flex-1 text-xs text-muted-foreground">
                  {offerLabel(o)}
                </span>
                <button
                  type="button"
                  onClick={() => void run(() => apply(i))}
                  disabled={busy}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  更新
                </button>
              </div>
            ))
          )}
          <button
            type="button"
            onClick={() => void run(check)}
            disabled={busy}
            className={buttonClass({ variant: "outline" })}
          >
            {busy ? "处理中…" : "检查更新"}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title="安装音源包"
        description="从链接粘贴 .js 直链（https），或从本地选择文件；数据包/播放包自动识别。"
      >
        <div className="flex w-full flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setInstallMode("url")}
              disabled={busy || installing || confirming}
              aria-pressed={installMode === "url"}
              className={
                "rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 " +
                (installMode === "url"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              从链接
            </button>
            <button
              type="button"
              onClick={() => setInstallMode("file")}
              disabled={busy || installing || confirming}
              aria-pressed={installMode === "file"}
              className={
                "rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 " +
                (installMode === "file"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              从本地文件
            </button>
          </div>
          {installMode === "url" ? (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/play-bundle.js"
              className="w-full rounded-md border border-border px-3 py-1.5 text-xs"
            />
          ) : null}
          <button
            type="button"
            onClick={installMode === "url" ? installUrl : installLocal}
            disabled={
              busy || installing || confirming || (installMode === "url" && !url.trim())
            }
            className={buttonClass({ variant: "outline" })}
          >
            {installing ? "获取包信息…" : installMode === "url" ? "安装" : "选择文件…"}
          </button>
        </div>
      </SettingRow>
      {/* 装包/换源/音质/排错的完整说明只在官网维护一份，客户端给个入口即可。
          官网地址是自有地址（只在 Rust 侧持有），未配置时整行不渲染 —— 宁可没有入口，
          也不要给一个打不开的链接 */}
      {siteUrl ? (
        <SettingRow
          title="如何设置音源"
          description="三种安装方式、切换默认音源、音质选择与装不上排查"
        >
          <ExternalLinkButton
            label="查看教程"
            url={officialSitePath(siteUrl, OFFICIAL_SOURCE_SETUP_PATH)}
          />
        </SettingRow>
      ) : null}
      {clipTip !== null && !preview && (
        <Modal
          open
          onClose={() => setClipTip(null)}
          size="sm"
          dismissible={false}
          closeOnBackdrop={false}
          className="bg-card/90"
          bodyClassName="p-4"
        >
          <div>
            <div className="text-sm font-medium text-foreground">
              检测到剪贴板有音源包链接
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {clipTip}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">是否安装？</p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setClipTip(null)}>
                取消
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const link = clipTip;
                  setClipTip(null);
                  if (link) stageFromLink(link);
                }}
              >
                安装
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {preview && (
        <InstallPreviewDialog
          preview={preview}
          busy={confirming}
          onConfirm={confirmInstall}
          onCancel={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/**
 * 安装预览确认弹窗（URL/本地文件安装的必经一步；manifest 通道的更新确认
 * 已含版本信息，不走这里）。官方 id 包在预览前已通过 ed25519 签名硬校验
 * （假包到不了这里），弹窗里直接展示「官方 · 已验签」。
 */

export function InstallPreviewDialog(props: {
  preview: PackPreviewVo;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const p = props.preview;
  const rows: Array<[string, React.ReactNode]> = [
    ["类型", kindLabel(p.kind)],
    ["名称", p.name.trim() || kindLabel(p.kind)],
    [
      "版本",
      p.versionName.trim() ? `${p.versionName} (code ${p.versionCode})` : `v${p.versionCode}`,
    ],
    ["包 id", <span key="id" className="font-mono">{p.id}</span>],
    [
      "来源",
      p.channel === "file"
        ? `本地文件 ${p.reference}`
        : p.reference || "—",
    ],
  ];
  return (
    <Modal
      open
      onClose={props.onCancel}
      size="sm"
      dismissible={!props.busy}
      className="bg-card/90"
      bodyClassName="p-4"
    >
      <div>
        <div className="text-sm font-medium text-foreground">安装音源包</div>
        <div className="mt-2 flex flex-col gap-1 text-xs">
          {rows.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <span className="w-10 shrink-0 text-muted-foreground">{key}</span>
              <span className="min-w-0 flex-1 break-all">{value}</span>
            </div>
          ))}
        </div>
        {p.installedCode > 0 ? (
          <p className="mt-2 text-2xs text-muted-foreground">
            将替换已安装的 v{p.installedCode}（同 id 原位更新）
          </p>
        ) : null}
        {p.signatureVerified ? (
          <div className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-2xs leading-relaxed text-primary">
            ✓ 官方签名校验通过（ed25519，与官方发布密钥匹配）
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={props.onCancel} disabled={props.busy}>
            取消
          </Button>
          <Button variant="primary" onClick={props.onConfirm} loading={props.busy}>
            {props.busy ? "安装中…" : "安装"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 包列表单行：单选启用 + 卸载（两击确认，武装态变红） */

export function PackRow(props: {
  pack: SourcePackVo;
  radioName: string;
  checked: boolean;
  busy: boolean;
  armed: boolean;
  onActivate: () => void;
  onUninstall: () => void;
}): React.JSX.Element {
  const activePlayWarn =
    props.pack.kind === "play" && props.checked && props.armed
      ? "卸载后在线播放将不可用"
      : "";
  // 次级信息行：安装来源 · 更新日期 ·（可选）上次失败摘要
  const metaBits = [
    installSourceLabel(props.pack.installSource),
    shortUpdateDate(props.pack.updatedAt),
  ].filter(Boolean);
  const errSummary = lastErrorSummary(props.pack.lastError);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <input
          type="radio"
          name={props.radioName}
          aria-label={`启用 ${packLabel(props.pack)}`}
          checked={props.checked}
          onChange={props.onActivate}
          disabled={props.busy}
        />
        <span className="flex-1 font-mono text-muted-foreground">
          {packLabel(props.pack)}
        </span>
        <button
          type="button"
          onClick={props.onUninstall}
          disabled={props.busy}
          className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
            props.armed
              ? "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/20"
              : "border-border text-destructive/80 hover:bg-accent"
          }`}
        >
          {props.armed ? "确认卸载" : "卸载"}
        </button>
      </div>
      {metaBits.length > 0 ? (
        <span className="pl-5 text-2xs text-muted-foreground">
          {metaBits.join(" · ")}
          {errSummary ? ` · 上次失败：${errSummary}` : ""}
        </span>
      ) : null}
      {activePlayWarn ? (
        <span className="pl-5 text-2xs text-destructive">{activePlayWarn}</span>
      ) : null}
    </div>
  );
}

