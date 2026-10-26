import { useEffect, useRef, useState } from "react";
import { stripErrorUrls } from "@/lib/utils";
import {
  mergeCredentialExtras,
  readSourceAuthAccounts,
  readSourceAuthAccountsSync,
  readSourceAuthTogglesFor,
  removeSourceAuthAccount,
  saveSourceAuthAccount,
  saveSourceAuthSyncPlaylists,
  setSourceAuthToggle,
  type SourceAuthAccount,
  type SourceAuthToggles,
} from "@/lib/source-auth";
import {
  authCheckUser,
  authImportCookie,
  authLoginByPassword,
  authLoginByPhone,
  authQrCreate,
  authQrPoll,
  authSendSms,
  type SourceAuthUser,
} from "@/source-scripts";
import { runWebLoginFlow } from "@/lib/source-web-login";
import { autoSyncMissingAfterLogin } from "@/lib/source-playlist-sync";
import { SourcePlaylistSyncDialog } from "./SourcePlaylistSyncDialog";
import { toast, toastError } from "@/stores/toast";
import { sourceQualityOptionsOf, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { qualityOptionsFromRegistry } from "@/lib/quality";
import {
  SOURCE_QUALITIES_CHANGED_EVENT,
  loadSourceQualities,
  setSourceDownloadQuality,
  setSourcePlayQuality,
  sourceDownloadQualityOf,
  sourcePlayQualityOf,
} from "@/lib/source-quality";
import type { Quality } from "@/types";

/**
 * 音源账号（路由 /source-accounts，侧边栏「我的」组、我的歌单下方）。
 *
 * 每个音源一张卡片，独立管理四件事：
 * - 登录本身：扫码 / 导入 Cookie（入口按数据包注册表的 auth.methods 显隐；
 *   旧包不声明 = 不显示登录按钮，只保留已存账号的退出）；
 * - 「数据请求使用登录态」（meta 面）与「播放请求使用登录态」（play 面）
 *   两个开关——**按源独立**，与设置页时期的全局一对开关不同：关掉 B 站的
 *   播放登录态不影响网易的任何一面；
 * - 播放音质 / 下载音质（2026-10-25 需求：各平台独立，设置页不再有全局音质）。
 *
 * 卡片清单 = 注册表全部源（顺序与展示一致；2026-10-25 用户需求「全平台写入
 * 音源账号」）——没有登录接口的源（如 kg/migu，官方登录态查询端点已失效）
 * 也有音质卡，只是不渲染登录行。
 *
 * 播放面登录态生效时，该源官方前置线路启用，音质选择整体切换到官方档位
 * 清单（注册表 auth.officialQualities，v10/v11）——下拉选项经
 * stores/sourceRegistry.sourceQualityOptionsOf 自动跟随。
 *
 * 登录动作全部走数据包的官方端点入口（authQrCreate/authQrPoll/authImportCookie/
 * authUser）；二维码 PNG 由数据包渲染成 data URI，凭据不出本机。
 */

/** 一张卡片要展示的源：methods 空数组 = 当前数据包不再声明该源可登录
 *  （只剩已存账号的展示与退出，不给登录入口）；例外是 webLogin（v17 契约）：
 *  数据包声明了网页登录时，methods 为空也显示「网页登录」入口 */
type SourceCard = {
  id: string;
  name: string;
  methods: string[];
  /** 数据包 auth.webLogin 声明（存在 = 显示网页登录按钮；note 作悬浮提示） */
  webLogin?: { url: string; cookieMarkers: string[]; note?: string; captureUrls?: string[] };
  /** 该源 auth.domains：旧包未下发 captureUrls 时回退拼接捕获地址用 */
  domains: string[];
};

function Switch(props: { checked: boolean; onToggle: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-disabled={props.disabled}
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) props.onToggle();
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 disabled:hover:cursor-not-allowed ${
        props.checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`absolute top-[0.125rem] h-4 w-4 rounded-full bg-background shadow transition-all ${
          props.checked ? "left-[1.125rem]" : "left-[0.125rem]"
        }`}
      />
    </button>
  );
}

export function SourceAccountsPage(): React.JSX.Element {
  const sources = useSourceRegistryStore((s) => s.sources);
  const ensure = useSourceRegistryStore((s) => s.ensure);
  /** 已登录账号（source → 凭据+用户信息）；loaded 区分「还没读」与「没有」 */
  const [accounts, setAccounts] = useState<Record<string, SourceAuthAccount>>({});
  const [loaded, setLoaded] = useState(false);
  /** 每源生效开关（source → { useMeta, usePlay }） */
  const [toggles, setToggles] = useState<Record<string, SourceAuthToggles>>({});
  /** 启动校验发现已失效的凭据（仍展示账号，标「已过期」引导重新登录） */
  const [stale, setStale] = useState<Record<string, boolean>>({});
  /** 扫码弹窗：非 null = 开着（含会话 key、二维码图与当前轮询状态） */
  const [qr, setQr] = useState<{
    source: string;
    sourceName: string;
    hint: string;
    key: string;
    image: string;
    status: "waiting" | "scanned" | "expired";
  } | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  /** Cookie 导入弹窗正在为哪个源开 */
  const [cookieSource, setCookieSource] = useState<string | null>(null);
  const [cookieText, setCookieText] = useState("");
  const [importing, setImporting] = useState(false);
  /** 短信登录（v14，酷我）：stage phone 输手机号 → sendSms → stage code 输验证码 */
  const [sms, setSms] = useState<{
    source: string;
    sourceName: string;
    stage: "phone" | "code";
    key: string;
    message: string;
  } | null>(null);
  const [phoneText, setPhoneText] = useState("");
  const [codeText, setCodeText] = useState("");
  const [smsBusy, setSmsBusy] = useState(false);
  /** 密码登录（v14，酷我官方客户端形制） */
  const [pwd, setPwd] = useState<{ source: string; sourceName: string } | null>(null);
  const [accountText, setAccountText] = useState("");
  const [pwdText, setPwdText] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);
  /** 退出两击确认（与卸载音源包同款，防误点掉凭据） */
  const [armedLogout, setArmedLogout] = useState<string | null>(null);
  /** 网页登录进行中的源（v17 契约）：期间禁用全部网页登录按钮（登录窗互斥） */
  const [webLoginBusy, setWebLoginBusy] = useState<string | null>(null);

  /** 卡片清单（2026-10-25 用户需求「全平台写入音源账号」）：注册表全部源按展示
   *  顺序——登录行仍按 auth.methods 门控（kg/migu 无登录接口不渲染登录区），
   *  播放/下载音质行全源都有；注册表之外残留账号的源排后面（只展示账号与
   *  退出——凭据还在库里，不能让用户找不到退出口）。 */
  const cards: SourceCard[] = [
    ...sources.map((s) => ({
      id: s.id,
      name: s.name,
      methods: s.auth?.methods ?? [],
      webLogin: s.auth?.webLogin,
      domains: s.auth?.domains ?? [],
    })),
    ...Object.keys(accounts)
      .filter((id) => !sources.some((s) => s.id === id))
      .map((id) => ({ id, name: id, methods: [], domains: [] })),
  ];

  useEffect(() => {
    void ensure();
    void (async () => {
      const acc = await readSourceAuthAccounts();
      setAccounts(acc);
      setLoaded(true);
      // 每源读生效开关（未物化的源走解析链：旧全局键 → 双开）
      const entries = await Promise.all(
        [...sources.map((s) => s.id), ...Object.keys(acc)].map(async (id) => [id, await readSourceAuthTogglesFor(id)] as const),
      );
      setToggles(Object.fromEntries(entries));
      // 各平台独立音质：先确保缓存装好（AppShell 启动也拉，这里幂等兜底）
      await loadSourceQualities();
      setQualityTick((t) => t + 1);
      // 已存凭据有效性：失效只标记不打扰（凭据保留，用户可选择重新登录）。
      // credential 非空 = 包侧已用 refresh_key 轮换出新 cookie（QQ 短期
      // musickey 保活），落库更新让官方线路/后续校验拿到新 keyst；轮换应答
      // 随行下发的 refresh_token（bili 等源）并入 extras 一并落库。
      for (const [source, account] of Object.entries(acc)) {
        authCheckUser(source, account.cookie, account.extras)
          .then((r) => {
            if (r.credential !== null && r.user !== null) {
              const extras = mergeCredentialExtras(account.extras, r.refreshToken);
              void saveSourceAuthAccount(source, r.credential, r.user, extras).catch(
                () => undefined,
              );
            }
            setStale((prev) => ({ ...prev, [source]: !r.ok }));
          })
          .catch(() => undefined);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 注册表 sources 只影响登录入口显隐，开关/账号初始读取只跑一次
  }, [ensure]);

  const refreshAccounts = (): void => setAccounts({ ...readSourceAuthAccountsSync() });

  /** 音质落库值变化（本页/播放条写入）→ 重渲染让下拉回到新值 */
  const [qualityTick, setQualityTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setQualityTick((t) => t + 1);
    window.addEventListener(SOURCE_QUALITIES_CHANGED_EVENT, bump);
    return () => window.removeEventListener(SOURCE_QUALITIES_CHANGED_EVENT, bump);
  }, []);
  /** 官方档位 profile 是异步查询的（登录/重灌包后到达），下拉用非响应式
   * sourceQualityOptionsOf 读取——profile 更新时手动 bump，避免停留在第三方清单 */
  const registryProfiles = useSourceRegistryStore((s) => s.profiles);
  useEffect(() => {
    setQualityTick((t) => t + 1);
  }, [registryProfiles]);

  const changePlayQuality = (source: string, q: string): void => {
    setSourcePlayQuality(source, q).catch((e) => {
      toastError(`播放音质保存失败：${stripErrorUrls(String(e))}`);
    });
  };

  const changeDownloadQuality = (source: string, q: string): void => {
    setSourceDownloadQuality(source, q).catch((e) => {
      toastError(`下载音质保存失败：${stripErrorUrls(String(e))}`);
    });
  };

  const startQr = (source: string, sourceName: string): void => {
    setQrBusy(true);
    authQrCreate(source)
      .then((session) => {
        // 扫码提示随包下发（v16）：QQ ptlogin 只能手机 QQ 扫，不是 QQ 音乐 App
        const hint = sources.find((s) => s.id === source)?.auth?.qrHint ?? "";
        setQr({ source, sourceName, hint, key: session.key, image: session.image, status: "waiting" });
      })
      .catch((e) => {
        toastError(`二维码创建失败：${stripErrorUrls(String(e))}`);
      })
      .finally(() => setQrBusy(false));
  };

  /** 网页登录（v17 契约 auth.webLogin）：打开官方登录窗，宿主按节奏轮询读
   *  Cookie（含 httpOnly，走 Rust source_web_login_capture），命中 marker 后
   *  authImportCookie 校验并 saveSourceAuthAccount 入库、自动关窗——全部在
   *  runWebLoginFlow 内完成；这里按三态结果用既有 toast 模式反馈。onProgress
   *  把「已捕获 Cookie 但校验未通过 / 超时原因」透出，避免长时间无反馈的
   *  静默轮询（用户在官方页登录完成后理应自动关窗，若没有会看到原因）。 */
  const startWebLogin = (item: SourceCard): void => {
    if (!item.webLogin || webLoginBusy !== null) return;
    setWebLoginBusy(item.id);
    let progressNote: string | null = null;
    runWebLoginFlow(
      { source: item.id, webLogin: item.webLogin, domains: item.domains },
      {
        onProgress: (msg) => {
          progressNote = msg;
          toast(msg);
        },
      },
    )
      .then(async (outcome) => {
        if (outcome === "timeout") {
          // 具体原因已由 onProgress 透出（捕获到 Cookie 校验不过 / 没捕获到）；
          // 兜底仅在一条进度都没有时给静态文案。
          if (progressNote === null) toast("网页登录超时，请重试");
          return;
        }
        if (outcome === "cancelled") {
          toast("网页登录已取消（你关闭了登录窗口）");
          return;
        }
        // ok：与扫码/短信/密码登录同款提示（用户信息从已入库账号取）
        const acc = readSourceAuthAccountsSync()[item.id];
        const tg = await readSourceAuthTogglesFor(item.id);
        setToggles((prev) => ({ ...prev, [item.id]: tg }));
        if (acc) {
          toast(`已登录${acc.user.nickname}（${acc.user.vip ? acc.user.vipLabel || "会员" : "非会员"}）`);
          // 落库成功的下一步：按「登录后同步歌单」开关决定是否自动拉差集
          maybeAutoSync(item.id, item.name);
        }
      })
      .catch((e) => {
        toastError(`网页登录失败：${stripErrorUrls(String(e))}`);
      })
      .finally(() => {
        setWebLoginBusy(null);
        refreshAccounts();
      });
  };

  // 轮询按「会话 key」起停：状态更新不改依赖，只有换二维码/关弹窗才重置间隔
  const qrKey = qr?.key;
  const qrSource = qr?.source;
  const qrSourceName = qr?.sourceName;
  useEffect(() => {
    if (qrKey === undefined || qrSource === undefined) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void authQrPoll(qrSource, qrKey)
        .then((r) => {
          if (cancelled) return;
          if (r.status === "confirmed") {
            // v17 起 bili 扫码确认会随 credential 下发 refresh_token（官方
            // cookie 刷新协议的凭据副键）：落库时并入 extras；其他源无此键
            // 合并结果为空，记录形状与旧版一致
            void saveSourceAuthAccount(
              qrSource,
              r.cookie,
              r.user,
              mergeCredentialExtras(undefined, r.refreshToken),
            )
              .then(async () => {
                const tg = await readSourceAuthTogglesFor(qrSource);
                setToggles((prev) => ({ ...prev, [qrSource]: tg }));
                refreshAccounts();
                setStale((prev) => ({ ...prev, [qrSource]: false }));
                setQr(null);
                toast(`已登录${r.user.nickname}（${r.user.vip ? r.user.vipLabel || "会员" : "非会员"}）`);
                // 落库成功的下一步：按「登录后同步歌单」开关决定是否自动拉差集
                maybeAutoSync(qrSource, qrSourceName ?? qrSource);
              })
              .catch((e) => {
                toastError(`登录态保存失败：${stripErrorUrls(String(e))}`);
              });
            return;
          }
          setQr((prev) =>
            prev && prev.key === qrKey && prev.status !== "expired"
              ? { ...prev, status: r.status === "scanned" ? "scanned" : r.status === "expired" ? "expired" : "waiting" }
              : prev,
          );
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [qrKey, qrSource, qrSourceName]);

  const importCookie = (): void => {
    if (cookieSource === null) return;
    const text = cookieText.trim();
    if (text.length === 0) {
      toast("请粘贴 Cookie 内容");
      return;
    }
    setImporting(true);
    const source = cookieSource;
    const sourceName = cards.find((c) => c.id === source)?.name ?? source;
    authImportCookie(source, text)
      .then((r) => {
        const user = r.user;
        if (!r.ok || user === null) {
          toast("Cookie 无效或已过期，请检查后重试");
          return;
        }
        // 导入的是用户手贴的 Cookie：无凭据副键，extras 留空由后台保活补齐
        return saveSourceAuthAccount(source, text, user, undefined).then(async () => {
          const tg = await readSourceAuthTogglesFor(source);
          setToggles((prev) => ({ ...prev, [source]: tg }));
          refreshAccounts();
          setStale((prev) => ({ ...prev, [source]: false }));
          setCookieSource(null);
          setCookieText("");
          toast(`已导入${sourceName}登录：${user.nickname}`);
          // 落库成功的下一步：按「登录后同步歌单」开关决定是否自动拉差集
          maybeAutoSync(source, sourceName);
        });
      })
      .catch((e) => {
        toastError(`导入失败：${stripErrorUrls(String(e))}`);
      })
      .finally(() => setImporting(false));
  };

  /** 短信/密码登录成功的公共落库路径（与扫码 confirmed 同流程）。
   *  短信/密码应答同样暂无凭据副键，extras 留空由后台保活轮换时补齐。
   *  sourceName 仅供落库成功后的自动同步弹窗标题用。 */
  const finishLogin = (source: string, cookie: string, user: SourceAuthUser, sourceName: string): Promise<void> =>
    saveSourceAuthAccount(source, cookie, user, undefined).then(async () => {
      const tg = await readSourceAuthTogglesFor(source);
      setToggles((prev) => ({ ...prev, [source]: tg }));
      refreshAccounts();
      setStale((prev) => ({ ...prev, [source]: false }));
      toast(`已登录${user.nickname}（${user.vip ? user.vipLabel || "会员" : "非会员"}）`);
      // 落库成功的下一步：按「登录后同步歌单」开关决定是否自动拉差集
      maybeAutoSync(source, sourceName);
    });

  const sendSms = (): void => {
    if (sms === null) return;
    const phone = phoneText.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      toast("请输入正确的手机号");
      return;
    }
    setSmsBusy(true);
    authSendSms(sms.source, phone)
      .then((r) => {
        setSms({ ...sms, stage: "code", key: r.key, message: r.message });
        toast(r.message.length > 0 ? r.message : "验证码已发送");
      })
      .catch((e) => toastError(`发送失败：${stripErrorUrls(String(e))}`))
      .finally(() => setSmsBusy(false));
  };

  const loginByPhone = (): void => {
    if (sms === null) return;
    const code = codeText.trim();
    if (code.length === 0) {
      toast("请输入验证码");
      return;
    }
    setSmsBusy(true);
    authLoginByPhone(sms.source, sms.key, code)
      .then((r) =>
        finishLogin(sms.source, r.cookie, r.user, sms.sourceName).then(() => {
          setSms(null);
          setPhoneText("");
          setCodeText("");
        }),
      )
      .catch((e) => toastError(`登录失败：${stripErrorUrls(String(e))}`))
      .finally(() => setSmsBusy(false));
  };

  const loginByPassword = (): void => {
    if (pwd === null) return;
    const account = accountText.trim();
    const password = pwdText;
    if (account.length === 0 || password.length === 0) {
      toast("请输入账号和密码");
      return;
    }
    setPwdBusy(true);
    authLoginByPassword(pwd.source, account, password)
      .then((r) =>
        finishLogin(pwd.source, r.cookie, r.user, pwd.sourceName).then(() => {
          setPwd(null);
          setAccountText("");
          setPwdText("");
        }),
      )
      .catch((e) => toastError(`登录失败：${stripErrorUrls(String(e))}`))
      .finally(() => setPwdBusy(false));
  };

  const logout = (source: string, sourceName: string): void => {    void removeSourceAuthAccount(source)
      .then(() => {
        refreshAccounts();
        toast(`已退出${sourceName}登录`);
      })
      .catch((e) => {
        toastError(`退出失败：${stripErrorUrls(String(e))}`);
      });
  };

  const toggleScope = (source: string, scope: "meta" | "play", on: boolean): void => {
    const current = toggles[source];
    if (current === undefined) return;
    setToggles((prev) => ({ ...prev, [source]: { ...current, [scope === "meta" ? "useMeta" : "usePlay"]: on } }));
    setSourceAuthToggle(source, scope, on).catch((e) => {
      setToggles((prev) => ({ ...prev, [source]: current }));
      toastError(`保存失败：${stripErrorUrls(String(e))}`);
    });
  };

  /** 账户歌单同步弹窗（2026-10-26 需求）：卡片「同步歌单」按钮与登录成功
   *  后的自动触发共用一个 state；null = 关闭。 */
  const [syncDialog, setSyncDialog] = useState<{ source: string; sourceName: string } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 登录成功后的自动同步：该源「登录后同步歌单」开着才拉差集预览；平台侧
   *  有本地没有的歌单就自动打开同步弹窗。预览失败（包旧/未实现/网络问题）
   *  只 console.warn 静默——不打扰登录成功的反馈；弹窗 state 更新前校验
   *  页面还挂着，卸载/竞态不再弹。 */
  const maybeAutoSync = (source: string, sourceName: string): void => {
    void autoSyncMissingAfterLogin(source)
      .then((missing) => {
        if (missing === null || missing.length === 0) return;
        if (!mountedRef.current) return;
        setSyncDialog({ source, sourceName });
      })
      .catch((e) => {
        console.warn(`[source-playlist-sync] 登录后自动同步预览失败（${source}）`, e);
      });
  };

  /** 「登录后同步歌单」开关（只在登录态显示；缺省开）。乐观更新 + 失败回滚，
   *  与 toggleScope 同款反馈。 */
  const toggleSyncPlaylists = (source: string, on: boolean): void => {
    const current = toggles[source];
    if (current === undefined) return;
    setToggles((prev) => ({ ...prev, [source]: { ...current, syncPlaylists: on } }));
    saveSourceAuthSyncPlaylists(source, on).catch((e) => {
      setToggles((prev) => ({ ...prev, [source]: current }));
      toastError(`保存失败：${stripErrorUrls(String(e))}`);
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">音源账号</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          扫码登录音源官方账号，凭据只存本机；每个音源单独决定数据/播放请求是否使用登录态。
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {cards.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {loaded
              ? "当前数据包不支持音源账号登录（需 2026.10.24 及以上版本的数据包）"
              : "正在读取音源清单…"}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {cards.map((item) => {
              const account = accounts[item.id];
              const tg = toggles[item.id] ?? { useMeta: true, usePlay: true };
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-border bg-card/60 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-sm font-medium">{item.name}</span>
                      {account ? (
                        stale[item.id] ? (
                          <span className="shrink-0 text-[11px] text-amber-500 dark:text-amber-400">
                            凭据已过期
                          </span>
                        ) : (
                          <span className="shrink-0 text-[11px] text-muted-foreground">已登录</span>
                        )
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted-foreground">未登录</span>
                      )}
                    </div>
                    {account ? (
                      <span className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSyncDialog({ source: item.id, sourceName: item.name })}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        >
                          同步歌单
                        </button>
                        {account.user.avatar ? (
                          <img
                            src={account.user.avatar}
                            alt=""
                            className="h-5 w-5 rounded-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : null}
                        <span className="max-w-32 truncate text-xs">
                          {account.user.nickname}
                          {account.user.vip && account.user.vipLabel ? `（${account.user.vipLabel}）` : ""}
                        </span>
                        {armedLogout === item.id ? (
                          <button
                            type="button"
                            onClick={() => {
                              setArmedLogout(null);
                              logout(item.id, item.name);
                            }}
                            className="rounded-md border border-destructive/60 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                          >
                            确认退出？
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setArmedLogout(item.id);
                              window.setTimeout(() => {
                                setArmedLogout((prev) => (prev === item.id ? null : prev));
                              }, 3000);
                            }}
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                          >
                            退出
                          </button>
                        )}
                      </span>
                    ) : item.methods.length > 0 || item.webLogin ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        {item.methods.includes("qrcode") ? (
                          <button
                            type="button"
                            onClick={() => startQr(item.id, item.name)}
                            disabled={qrBusy}
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                          >
                            {qrBusy ? "创建中…" : "扫码登录"}
                          </button>
                        ) : null}
                        {item.methods.includes("cookie") ? (
                          <button
                            type="button"
                            onClick={() => {
                              setCookieSource(item.id);
                              setCookieText("");
                            }}
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                          >
                            导入Cookie
                          </button>
                        ) : null}
                        {item.methods.includes("sms") ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSms({ source: item.id, sourceName: item.name, stage: "phone", key: "", message: "" });
                              setPhoneText("");
                              setCodeText("");
                            }}
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                          >
                            短信登录
                          </button>
                        ) : null}
                        {item.methods.includes("password") ? (
                          <button
                            type="button"
                            onClick={() => {
                              setPwd({ source: item.id, sourceName: item.name });
                              setAccountText("");
                              setPwdText("");
                            }}
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                          >
                            密码登录
                          </button>
                        ) : null}
                        {item.webLogin ? (
                          <button
                            type="button"
                            title={item.webLogin.note || "打开官方登录页完成登录，宿主自动读取登录态"}
                            onClick={() => startWebLogin(item)}
                            disabled={webLoginBusy !== null}
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                          >
                            {webLoginBusy === item.id ? "登录中…" : "网页登录"}
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-2 border-t border-border/70 pt-1">
                    <div className="flex items-center justify-between gap-4 py-2">
                      <div className="min-w-0">
                        <p className="text-sm">数据请求使用登录态</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          搜索/歌单/歌词等数据请求带上该源凭据（如B站登录后才能取AI字幕歌词）。
                        </p>
                      </div>
                      <Switch
                        checked={tg.useMeta}
                        onToggle={() => toggleScope(item.id, "meta", !tg.useMeta)}
                        disabled={!account}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4 py-2">
                      <div className="min-w-0">
                        <p className="text-sm">播放请求使用登录态</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          取链/播放请求带上该源凭据（如大会员解锁 hires/dolby 音质档）。与数据请求互不影响。
                        </p>
                      </div>
                      <Switch
                        checked={tg.usePlay}
                        onToggle={() => toggleScope(item.id, "play", !tg.usePlay)}
                        disabled={!account}
                      />
                    </div>
                    {account ? (
                      <div className="flex items-center justify-between gap-4 py-2">
                        <div className="min-w-0">
                          <p className="text-sm">登录后同步歌单</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            登录成功后自动拉取该账户在平台侧的收藏歌单，提示收藏本地还没有的；也可随时点上方「同步歌单」手动触发。
                          </p>
                        </div>
                        <Switch
                          checked={tg.syncPlaylists ?? true}
                          onToggle={() => toggleSyncPlaylists(item.id, !(tg.syncPlaylists ?? true))}
                        />
                      </div>
                    ) : null}
                    {(
                      <>
                        {([
                          { key: "play", title: "播放音质", desc: "播放该源歌曲时的取址音质；播放条音质按钮会同步改这里。", value: sourcePlayQualityOf(item.id), change: changePlayQuality },
                          { key: "download", title: "下载音质", desc: "下载该源歌曲时的目标音质。", value: sourceDownloadQualityOf(item.id), change: changeDownloadQuality },
                        ] as const).map((row) => {
                          const declared = qualityOptionsFromRegistry(sourceQualityOptionsOf(item.id));
                          // 落库值不在该源档位清单里（换包/换清单）时保留显示，
                          // 避免下拉显示与实际存储不符的假值；发起时会按源钳到可用档
                          const opts = declared.some((o) => o.value === row.value)
                            ? declared
                            : [
                                { value: row.value, label: row.value, short: row.value.toUpperCase() },
                                ...declared,
                              ];
                          const current = row.value;
                          return (
                            <div key={`${row.key}-${qualityTick}`} className="flex items-center justify-between gap-4 py-2">
                              <div className="min-w-0">
                                <p className="text-sm">{row.title}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">{row.desc}</p>
                              </div>
                              <select
                                value={current}
                                aria-label={`${item.name} ${row.title}`}
                                onChange={(e) => row.change(item.id, e.target.value as Quality)}
                                className="shrink-0 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {opts.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}（{o.short}）
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {qr !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs rounded-xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur-xl">
            <div className="text-sm font-medium text-foreground">
              {qr.sourceName} · 扫码登录
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {qr.hint.length > 0
                ? `${qr.hint}；二维码几分钟内有效，过期可刷新。`
                : `用${qr.sourceName}官方 App 扫码；二维码几分钟内有效，过期可刷新。`}
            </p>
            <div className="mt-3 flex justify-center">
              <img
                src={qr.image}
                alt="登录二维码"
                className={`h-52 w-52 rounded-lg border border-border ${qr.status === "expired" ? "opacity-30" : ""}`}
              />
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {qr.status === "waiting"
                ? "等待扫码…"
                : qr.status === "scanned"
                  ? "已扫码，请在手机上确认"
                  : "二维码已过期"}
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              {qr.status === "expired" ? (
                <button
                  type="button"
                  onClick={() => startQr(qr.source, qr.sourceName)}
                  disabled={qrBusy}
                  className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {qrBusy ? "刷新中…" : "刷新二维码"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setQr(null)}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {cookieSource !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur-xl">
            <div className="text-sm font-medium text-foreground">
              {cards.find((c) => c.id === cookieSource)?.name ?? cookieSource} · 导入 Cookie
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              粘贴浏览器里该音源官网的 Cookie 串（如 SESSDATA=…; bili_jct=… 或 MUSIC_U=…），
              导入前会先经官方接口校验有效性。
            </p>
            <textarea
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              rows={4}
              spellCheck={false}
              className="mt-3 w-full rounded-md border border-border bg-background/60 p-2 font-mono text-xs outline-none focus:border-primary"
              placeholder="粘贴 Cookie…"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCookieSource(null);
                  setCookieText("");
                }}
                disabled={importing}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={importCookie}
                disabled={importing}
                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {importing ? "校验中…" : "导入"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {sms !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur-xl">
            <div className="text-sm font-medium text-foreground">
              {sms.sourceName} · 短信登录
            </div>
            {sms.stage === "phone" ? (
              <>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  输入{sms.sourceName}绑定的手机号，验证码由官方下发。
                </p>
                <input
                  value={phoneText}
                  onChange={(e) => setPhoneText(e.target.value)}
                  inputMode="numeric"
                  maxLength={11}
                  spellCheck={false}
                  className="mt-3 w-full rounded-md border border-border bg-background/60 p-2 text-sm outline-none focus:border-primary"
                  placeholder="手机号"
                />
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSms(null)}
                    disabled={smsBusy}
                    className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={sendSms}
                    disabled={smsBusy}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {smsBusy ? "发送中…" : "发送验证码"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {sms.message.length > 0 ? sms.message : "验证码已发送，请查看短信。"}
                </p>
                <input
                  value={codeText}
                  onChange={(e) => setCodeText(e.target.value)}
                  inputMode="numeric"
                  maxLength={8}
                  spellCheck={false}
                  className="mt-3 w-full rounded-md border border-border bg-background/60 p-2 text-sm outline-none focus:border-primary"
                  placeholder="验证码"
                />
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSms(null)}
                    disabled={smsBusy}
                    className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={loginByPhone}
                    disabled={smsBusy}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {smsBusy ? "登录中…" : "登录"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {pwd !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card/90 p-4 shadow-lg backdrop-blur-xl">
            <div className="text-sm font-medium text-foreground">
              {pwd.sourceName} · 密码登录
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              使用{pwd.sourceName}官方客户端账号密码登录，凭据不出本机。
            </p>
            <input
              value={accountText}
              onChange={(e) => setAccountText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="mt-3 w-full rounded-md border border-border bg-background/60 p-2 text-sm outline-none focus:border-primary"
              placeholder="账号（手机号/用户名）"
            />
            <input
              value={pwdText}
              onChange={(e) => setPwdText(e.target.value)}
              type="password"
              autoComplete="new-password"
              className="mt-2 w-full rounded-md border border-border bg-background/60 p-2 text-sm outline-none focus:border-primary"
              placeholder="密码"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPwd(null)}
                disabled={pwdBusy}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={loginByPassword}
                disabled={pwdBusy}
                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {pwdBusy ? "登录中…" : "登录"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {syncDialog !== null ? (
        <SourcePlaylistSyncDialog
          source={syncDialog.source}
          sourceName={syncDialog.sourceName}
          onClose={() => setSyncDialog(null)}
          onDone={() => {
            // 收藏动作改的是「我的歌单」，页面本身只需保持账号缓存一致
            refreshAccounts();
          }}
        />
      ) : null}
    </div>
  );
}
