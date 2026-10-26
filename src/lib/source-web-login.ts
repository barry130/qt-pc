/**
 * 音源账号网页登录流程（v17 契约 auth.webLogin）。
 *
 * 数据包在 auth.webLogin 里声明 { url, cookieMarkers, note?, captureUrls? }：
 * 宿主打开官方登录页（Rust web_login.rs 的 qt-source-web-login 窗口），用户在
 * 窗口内走官方方式（QQ/微信/手机号…）登录；这里按固定节奏轮询读 Cookie
 * （含 httpOnly，必须走 Rust source_web_login_capture），合并命中任一
 * cookieMarkers 就走 authImportCookie 校验并 saveSourceAuthAccount 入库、关窗。
 * 校验才是权威——marker 只决定「何时开始尝试校验」，校验不过就继续轮询。
 *
 * 依赖注入：默认实现接 ipc 三包装 + source-scripts 的 authImportCookie +
 * lib/source-auth 的 saveSourceAuthAccount；单测全 mock。
 */
import * as ipc from "@/services/ipc";
import { authImportCookie, type SourceAuthUser } from "@/source-scripts";
import { saveSourceAuthAccount } from "@/lib/source-auth";

/** runWebLoginFlow 的三态结果（页面据此提示） */
export type WebLoginOutcome = "ok" | "timeout" | "cancelled";

/** capture 的返回：closed=true 表示登录窗口已不存在（用户手动关闭） */
export interface WebLoginCapture {
  closed: boolean;
  /** 逐 URL 拼好的 Cookie 字符串（"name=value; …"） */
  chunks: string[];
}

/** runWebLoginFlow 的可注入依赖（全部可换桩） */
export interface WebLoginDeps {
  /** 打开（或重建）登录窗口 */
  openWindow(url: string): Promise<void>;
  /** 逐 URL 读 Cookie；closed=true = 窗口已被用户关闭（立即收摊） */
  capture(urls: string[]): Promise<WebLoginCapture>;
  /** 官方校验：ok=false = Cookie 无效（继续轮询） */
  validateImport(
    source: string,
    cookie: string,
  ): Promise<{ ok: boolean; user: SourceAuthUser | null }>;
  /** 入库（落库 + 开关物化 + 注入 + 广播） */
  save(source: string, cookie: string, user: SourceAuthUser): Promise<void>;
  /** 关闭并销毁登录窗口 */
  closeWindow(): Promise<void>;
}

/** runWebLoginFlow 的入参：源 id + 数据包下发的 webLogin 声明 */
export interface WebLoginArgs {
  source: string;
  webLogin: { url: string; cookieMarkers: string[]; note?: string; captureUrls?: string[] };
  /**
   * 该源 auth.domains（可选）：webLogin.captureUrls 缺省（旧包/未下发）时，
   * 回退按 domains 拼 https://{domain}/ 作为捕获地址。captureUrls 才是权威
   * （host-only Cookie 如 y.qq.com 的 qm_keyst 用 https://qq.com/ 读不到）。
   */
  domains?: string[];
}

/** runWebLoginFlow 的可调节奏（与扫码登录同量级） */
export interface WebLoginTiming {
  /** 轮询间隔，默认 1500ms */
  intervalMs?: number;
  /** 总时长上限，默认 3 分钟 */
  timeoutMs?: number;
}

/** 把各 URL 的 Cookie 字符串合并成一条（按 name 去重，先到先得）。
 * 输入是 Rust 侧逐 URL 拼好的 "name=value; name2=v2"，这里拆开归一。 */
export function mergeCookies(chunks: string[]): string {
  const pairs = new Map<string, string>();
  for (const chunk of chunks) {
    for (const part of chunk.split(";")) {
      const text = part.trim();
      if (text.length === 0) continue;
      const eq = text.indexOf("=");
      if (eq <= 0) continue;
      const name = text.slice(0, eq).trim();
      const value = text.slice(eq + 1).trim();
      if (name.length === 0 || !pairs.has(name)) pairs.set(name, value);
    }
  }
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** 任一 marker 命中（包含匹配）；markers 为空 = 有任意 Cookie 即试 */
function markerHit(cookie: string, markers: string[]): boolean {
  if (markers.length === 0) return cookie.length > 0;
  return markers.some((m) => m.length > 0 && cookie.includes(m));
}

/** 捕获地址：captureUrls 优先，缺省回退按 domains 拼 https://{domain}/ */
function captureUrlsOf(args: WebLoginArgs): string[] {
  if (args.webLogin.captureUrls && args.webLogin.captureUrls.length > 0) {
    return args.webLogin.captureUrls;
  }
  return (args.domains ?? [])
    .filter((d) => d.length > 0)
    .map((d) => (d.startsWith("https://") ? d : `https://${d}/`));
}

/** 默认依赖：接 ipc 与现有校验/入库入口 */
function defaultDeps(): Pick<
  WebLoginDeps,
  "openWindow" | "capture" | "validateImport" | "save" | "closeWindow"
> {
  return {
    openWindow: (url) => ipc.sourceWebLoginOpen(url),
    capture: (urls) => ipc.sourceWebLoginCapture(urls),
    validateImport: (source, cookie) => authImportCookie(source, cookie),
    save: (source, cookie, user) => saveSourceAuthAccount(source, cookie, user),
    closeWindow: () => ipc.sourceWebLoginClose(),
  };
}

/**
 * 跑一轮网页登录：openWindow → 每 intervalMs 捕获一次 Cookie → 合并去重 →
 * 命中任一 cookieMarkers（空 markers = 有任意 Cookie）→ authImportCookie 校验
 * → ok 则 save + closeWindow + "ok"；校验不过继续轮询；capture 返回
 * closed=true（用户手动关窗）→ "cancelled" 立即收摊（不能等超时，否则按钮
 * 会一直卡在「登录中…」）；总时长 timeoutMs 未果 → closeWindow + "timeout"；
 * capture/open 抛错 → closeWindow 兜底 + "cancelled"。
 */
export async function runWebLoginFlow(
  args: WebLoginArgs,
  overrides?: Partial<WebLoginDeps> & WebLoginTiming,
): Promise<WebLoginOutcome> {
  const deps: WebLoginDeps = { ...defaultDeps(), ...overrides };
  const intervalMs = overrides?.intervalMs ?? 1500;
  const timeoutMs = overrides?.timeoutMs ?? 180_000;
  const urls = captureUrlsOf(args);
  const deadline = Date.now() + timeoutMs;
  try {
    await deps.openWindow(args.webLogin.url);
    while (Date.now() < deadline) {
      const captured = await deps.capture(urls);
      if (captured.closed) {
        // 用户把登录窗口关了：窗口已不存在（closeWindow 是幂等销毁，这里
        // 不必再调），立即结束，让页面把「登录中…」复位。
        return "cancelled";
      }
      const cookie = mergeCookies(captured.chunks);
      if (markerHit(cookie, args.webLogin.cookieMarkers)) {
        let verdict: { ok: boolean; user: SourceAuthUser | null };
        try {
          verdict = await deps.validateImport(args.source, cookie);
        } catch {
          // 校验通道故障（引擎未就绪等）：按「还没登好」继续轮询
          verdict = { ok: false, user: null };
        }
        if (verdict.ok && verdict.user !== null) {
          await deps.save(args.source, cookie, verdict.user);
          await deps.closeWindow();
          return "ok";
        }
      }
      await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)));
    }
    await deps.closeWindow();
    return "timeout";
  } catch (e) {
    // capture/open 抛错 = 现场已破坏（用户手动关窗等）：兜底关窗收摊
    void e;
    await deps.closeWindow().catch(() => undefined);
    return "cancelled";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
