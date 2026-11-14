import { useCallback, useEffect, useState } from "react";
import { useOfficialSiteUrl } from "@/hooks/useOfficialSiteUrl";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useT } from "@/lib/i18n";
import { OFFICIAL_SOURCE_SETUP_PATH, officialSitePath } from "@/lib/official-site";
import { stripErrorUrls } from "@/lib/utils";
import * as ipc from "@/services/ipc";
import { SOURCE_META_CHANGED_EVENT, SOURCE_PACK_CHANGED_EVENT } from "@/services/ipc";
import { activateSourcePack, applySourceUpdate, discoverSourceUpdates, getSourceState, installStagedSource, isPackLinkUrl, lastErrorSummary, packDisplayName, packVersionLabel, shortUpdateDate, stageSourceFromFile, stageSourceFromUrl, uninstallSourcePack, type PackPreviewVo, type PackUpdateOfferVo, type SourcePackVo } from "@/source-scripts/source-update";
import { useSourceUpdateStore } from "@/stores/source-update";
import { toast, toastError, toastSuccess } from "@/stores/toast";
import { ExternalLink } from "lucide-react";
import { SettingRow } from "../controls";
import { Button, Modal } from "@/components/ui";
import { buttonClass } from "@/components/ui";

export function packLabel(p: SourcePackVo): string {
  return `${packDisplayName(p)} · ${packVersionLabel(p)} (code ${p.versionCode})`;
}

/** `tr()` 的类型：模块级 helper 没有 hook 上下文，只能把取词函数当参数传进来 */
type Translate = ReturnType<typeof useT>;

/** 包类型名（`source-update` 的 `kindLabel` 是写死的中文，界面文案得跟着语言走） */
function kindText(tr: Translate, kind: string): string {
  return kind === "meta"
    ? tr("settings.sourcePackage.kindMeta")
    : tr("settings.sourcePackage.kindPlay");
}

/** 安装来源（同上：`installSourceLabel` 也是写死的中文常量） */
function installSourceText(tr: Translate, source: string): string {
  switch (source) {
    case "url":
      return tr("settings.sourcePackage.installSourceUrl");
    case "file":
      return tr("settings.sourcePackage.installSourceFile");
    case "manifest":
      return tr("settings.sourcePackage.installSourceManifest");
    default:
      return "—";
  }
}

/** 动作回执：`text` 是给用户看的一句，`ok` 决定绿勾（成功）还是普通 Toast（中性提示） */
type Receipt = { text: string; ok: boolean };

function success(text: string): Receipt {
  return { text, ok: true };
}

function notice(text: string): Receipt {
  return { text, ok: false };
}

/** 卸载按钮的「两击确认」状态：null = 未武装；否则记录包 id 与计时器 */
type ArmedUninstall = { packId: string; timer: number };

/** 本会话已提示过的剪贴板链接（同一链接只提示一次，忽略/安装都算） */
const PROMPTED_CLIPBOARD_LINKS = new Set<string>();

/** 音源包分区（设置 → 音源包）：只管数据/播放包的安装、更新、卸载与状态展示。
 *  2026-11-14 合三为一：音乐源启用/优先级、聚合搜索、音源账号三块并入侧边栏
 *  「音源平台管理」页（/source-accounts，改名后路由不变），本分区不再渲染它们。 */
export function SourcePackageSection(): React.JSX.Element {
  const tr = useT();
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
   * 动作回执按性质分流后走右上角 Toast：成功回执给绿勾；「已是最新 / 发现 N 个 /
   * 再点一次」这类中性提示走普通样式，不打断也不需要在页面里停留。
   *
   * 分流看回执里的 `ok`，不看文案：以前靠「是不是以『已』开头」猜，界面翻成英文
   * 之后就再也猜不出来了 —— 每条回执自己说清是成功还是中性提示。
   */
  const report = (receipt: Receipt): void => {
    if (receipt.ok) {
      toastSuccess(receipt.text);
    } else {
      toast(receipt.text);
    }
  };

  const run = async (action: () => Promise<Receipt>): Promise<void> => {
    setBusy(true);
    try {
      report(await action());
    } catch (e) {
      toastError(
        tr("settings.sourcePackage.actionFailed", { message: stripErrorUrls(String(e)) }),
      );
    } finally {
      setBusy(false);
    }
  };

  /** 更新提示：`数据包有新版本：v1 → v2（名称）`（lib 的 `offerLabel` 是写死的中文） */
  const offerText = (offer: PackUpdateOfferVo): string =>
    tr("settings.sourcePackage.offerUpdate", {
      kind: kindText(tr, offer.kind),
      from:
        offer.currentCode > 0
          ? `v${offer.currentCode}`
          : tr("settings.sourcePackage.notInstalledVersion"),
      newCode: offer.newCode,
      newName: offer.newName,
    });

  /** 手动检查（force=true 越过 4h/包 探测节流；发现不自动安装） */
  const check = async (): Promise<Receipt> => {
    const result = await discoverSourceUpdates(true);
    setOffers(result.offers);
    await refresh();
    if (!result.offers.length) return notice(tr("settings.sourcePackage.upToDate"));
    return notice(
      tr("settings.sourcePackage.updatesFound", { count: result.offers.length }),
    );
  };

  /** 应用单条更新 offer（失败 Rust 自动回滚并拉黑该版本，这里只需提示） */
  const apply = async (index: number): Promise<Receipt> => {
    const offer = offers[index];
    if (!offer) return notice(tr("settings.sourcePackage.noUpdate"));
    const outcome = await applySourceUpdate(offer);
    dropOffer(offer.targetId, offer.kind);
    await refresh();
    return success(
      tr("settings.sourcePackage.updatedTo", {
        kind: kindText(tr, outcome.kind),
        code: outcome.pack.versionCode,
        name: outcome.pack.name,
      }),
    );
  };

  /** 启用包 / 停用数据槽（packId 空串 + kind=meta = 停用数据包，数据面下线） */
  const activate = async (
    packId: string,
    kind: "meta" | "play",
  ): Promise<Receipt> => {
    await activateSourcePack(packId, kind);
    await refresh();
    if (kind === "meta") {
      return success(
        packId
          ? tr("settings.sourcePackage.switchedDataPack")
          : tr("settings.sourcePackage.disabledDataPack"),
      );
    }
    return success(tr("settings.sourcePackage.switchedPlayPack"));
  };

  /** 两击确认的卸载：第一击武装（3 秒内再点确认），第二击执行 */
  const uninstall = async (pack: SourcePackVo): Promise<Receipt> => {
    if (armed?.packId !== pack.id) {
      if (armed?.timer) window.clearTimeout(armed.timer);
      setArmed({
        packId: pack.id,
        timer: window.setTimeout(() => setArmed(null), 3000),
      });
      return notice(tr("settings.sourcePackage.confirmUninstallAgain"));
    }
    if (armed.timer) window.clearTimeout(armed.timer);
    setArmed(null);
    const wasActivePlay = pack.kind === "play" && local?.activeId === pack.id;
    await uninstallSourcePack(pack.id);
    await refresh();
    return success(
      wasActivePlay
        ? tr("settings.sourcePackage.uninstalledPlayPack")
        : tr("settings.sourcePackage.uninstalledKind", { kind: kindText(tr, pack.kind) }),
    );
  };

  /** 预览安装第一步：拉全文+静态校验，把预览信息交给确认弹窗（不落盘） */
  const stageFromLink = (link: string): void => {
    if (busy || installing || confirming || preview) return;
    setInstalling(true);
    void (async () => {
      try {
        setPreview(await stageSourceFromUrl(link));
      } catch (e) {
        toastError(
          tr("settings.sourcePackage.fetchInfoFailed", { message: stripErrorUrls(String(e)) }),
        );
      } finally {
        setInstalling(false);
      }
    })();
  };

  const installUrl = (): void => {
    const trimmed = url.trim();
    if (!trimmed) {
      // 按钮在链接为空时本来就是 disabled，这里只是兜底
      toast(tr("settings.sourcePackage.needPackUrl"));
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
        toastError(
          tr("settings.sourcePackage.fetchInfoFailed", { message: stripErrorUrls(String(e)) }),
        );
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
          outcome.activated
            ? tr("settings.sourcePackage.installedActive", {
                kind: kindText(tr, outcome.kind),
              })
            : tr("settings.sourcePackage.installedInactive", {
                kind: kindText(tr, outcome.kind),
              }),
        );
      } catch (e) {
        setPreview(null);
        toastError(
          tr("settings.sourcePackage.installFailed", { message: stripErrorUrls(String(e)) }),
        );
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
    : tr("settings.sourcePackage.metaNotInstalled");
  const playStatus = activePlay
    ? packLabel(activePlay)
    : tr("settings.sourcePackage.playNotInstalled");

  return (
    <div className="max-w-4xl divide-y divide-border">
      {/* 用户 m11501：教程入口置顶强调，其余行从它下方开始 */}
      {siteUrl ? (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void ipc.openExternalUrl(officialSitePath(siteUrl, OFFICIAL_SOURCE_SETUP_PATH)).catch(() => undefined);
          }}
          className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-primary/25 bg-primary/8 px-4 py-3 transition-colors hover:bg-primary/12"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {tr("settings.sourcePackage.setupGuideTitle")}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {tr("settings.sourcePackage.setupGuideDesc")}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-medium text-primary">
            {tr("settings.sourcePackage.viewGuide")}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </span>
        </a>
      ) : null}
      <SettingRow
        title={tr("settings.sourcePackage.dataPackTitle")}
        description={tr("settings.sourcePackage.dataPackDesc")}
      >
        <span className="font-mono text-xs text-muted-foreground">{metaStatus}</span>
      </SettingRow>
      <SettingRow
        title={tr("settings.sourcePackage.playPackTitle")}
        description={tr("settings.sourcePackage.playPackDesc")}
      >
        <span className="font-mono text-xs text-muted-foreground">{playStatus}</span>
      </SettingRow>
      {/* 2026-11-14 合三为一：音乐源启用/优先级（SourcePolicySection）、聚合搜索
          （AggregateSourcesRow）、音源账号入口（SourceAccountSection）全部并入
          侧边栏「音源平台管理」页（/source-accounts），设置里只留包的安装/
          更新/卸载（用户裁定）。 */}
      <SettingRow
        title={tr("settings.sourcePackage.installedTitle")}
        description={tr("settings.sourcePackage.installedDesc", {
          count: packs.length,
          meta: metaPacks.length,
          play: playPacks.length,
        })}
      >
        <div className="flex w-full flex-col gap-2">
          {packs.length === 0 && (
            <span className="text-xs text-muted-foreground">
              {tr("settings.sourcePackage.noPacks")}
            </span>
          )}
          {metaPacks.length > 0 && (
            <span className="text-2xs font-medium text-muted-foreground">
              {tr("settings.sourcePackage.dataPacksGroup")}
            </span>
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
                aria-label={tr("settings.sourcePackage.disableDataPackAria")}
                checked={!local?.activeMetaId}
                onChange={() => void run(() => activate("", "meta"))}
                disabled={busy}
              />
              <span className="flex-1 font-mono text-muted-foreground">
                {tr("settings.sourcePackage.disableDataPack")}
              </span>
            </div>
          )}
          {playPacks.length > 0 && (
            <span className="mt-1 text-2xs font-medium text-muted-foreground">
              {tr("settings.sourcePackage.playPacksGroup")}
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
      <SettingRow
        title={tr("settings.sourcePackage.updatesTitle")}
        description={tr("settings.sourcePackage.updatesDesc")}
      >
        <div className="flex w-full flex-col items-end gap-2">
          {offers.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {tr("settings.sourcePackage.noUpdates")}
            </span>
          ) : (
            offers.map((o, i) => (
              <div
                key={`${o.kind}:${o.targetId}`}
                className="flex w-full items-center gap-2"
              >
                <span className="flex-1 text-xs text-muted-foreground">
                  {offerText(o)}
                </span>
                <button
                  type="button"
                  onClick={() => void run(() => apply(i))}
                  disabled={busy}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {tr("settings.sourcePackage.update")}
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
            {busy
              ? tr("settings.sourcePackage.processing")
              : tr("settings.sourcePackage.checkUpdates")}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        title={tr("settings.sourcePackage.installTitle")}
        description={tr("settings.sourcePackage.installDesc")}
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
              {tr("settings.sourcePackage.fromUrl")}
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
              {tr("settings.sourcePackage.fromFile")}
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
            {installing
              ? tr("settings.sourcePackage.fetchingInfo")
              : installMode === "url"
                ? tr("settings.sourcePackage.install")
                : tr("settings.sourcePackage.chooseFile")}
          </button>
        </div>
      </SettingRow>
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
              {tr("settings.sourcePackage.clipboardFound")}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {clipTip}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("settings.sourcePackage.clipboardAsk")}
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setClipTip(null)}>
                {tr("common.cancel")}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const link = clipTip;
                  setClipTip(null);
                  if (link) stageFromLink(link);
                }}
              >
                {tr("settings.sourcePackage.install")}
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
  const tr = useT();
  const p = props.preview;
  const rows: Array<[string, React.ReactNode]> = [
    [tr("settings.sourcePackage.previewType"), kindText(tr, p.kind)],
    [tr("settings.sourcePackage.previewName"), p.name.trim() || kindText(tr, p.kind)],
    [
      tr("settings.sourcePackage.previewVersion"),
      p.versionName.trim() ? `${p.versionName} (code ${p.versionCode})` : `v${p.versionCode}`,
    ],
    [
      tr("settings.sourcePackage.previewPackId"),
      <span key="id" className="font-mono">{p.id}</span>,
    ],
    [
      tr("settings.sourcePackage.previewSource"),
      p.channel === "file"
        ? tr("settings.sourcePackage.previewLocalFile", { reference: p.reference })
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
        <div className="text-sm font-medium text-foreground">
          {tr("settings.sourcePackage.installTitle")}
        </div>
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
            {tr("settings.sourcePackage.replaceInstalled", { code: p.installedCode })}
          </p>
        ) : null}
        {p.signatureVerified ? (
          <div className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-2xs leading-relaxed text-primary">
            {tr("settings.sourcePackage.signatureOk")}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={props.onCancel} disabled={props.busy}>
            {tr("common.cancel")}
          </Button>
          <Button variant="primary" onClick={props.onConfirm} loading={props.busy}>
            {props.busy
              ? tr("settings.sourcePackage.installing")
              : tr("settings.sourcePackage.install")}
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
  const tr = useT();
  const activePlayWarn =
    props.pack.kind === "play" && props.checked && props.armed
      ? tr("settings.sourcePackage.uninstallWillBreakPlay")
      : "";
  // 次级信息行：安装来源 · 更新日期 ·（可选）上次失败摘要
  const metaBits = [
    installSourceText(tr, props.pack.installSource),
    shortUpdateDate(props.pack.updatedAt),
  ].filter(Boolean);
  const errSummary = lastErrorSummary(props.pack.lastError);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <input
          type="radio"
          name={props.radioName}
          aria-label={tr("settings.sourcePackage.enablePackAria", {
            name: packLabel(props.pack),
          })}
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
          {props.armed
            ? tr("settings.sourcePackage.confirmUninstall")
            : tr("settings.sourcePackage.uninstall")}
        </button>
      </div>
      {metaBits.length > 0 ? (
        <span className="pl-5 text-2xs text-muted-foreground">
          {metaBits.join(" · ")}
          {errSummary ? tr("settings.sourcePackage.lastErrorSuffix", { message: errSummary }) : ""}
        </span>
      ) : null}
      {activePlayWarn ? (
        <span className="pl-5 text-2xs text-destructive">{activePlayWarn}</span>
      ) : null}
    </div>
  );
}

