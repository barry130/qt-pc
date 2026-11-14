import type { MusicInfo, RequestBuiltin } from "@/source-scripts/qt-contract/contract";

/** Test-only protocol peer. This is not an implementation of a source pack.
 * The PC auth/facade/engine path remains real; host HTTP is controlled by the
 * session tests. Run test:account-integration to use real registered handlers.
 */
export interface AccountMetaHost { request: RequestBuiltin; platform: number }
type Args = Record<string, unknown>;
type Entry = (args: Args) => string | Promise<string>;

const ACCOUNT = "https://music.163.com/weapi/w/nuser/account/get";
const DAILY = "https://music.163.com/weapi/v3/discovery/recommend/songs";
const FM = "https://music.163.com/weapi/v1/radio/get";
const DAILY_SONG: MusicInfo = {
  id: "902", name: "Owned daily song", singer: "Owned singer", album: "Owned album", picUrl: "", interval: 201.5,
};
const FM_SONG: MusicInfo = {
  id: "701", name: "Owned FM song", singer: "Owned FM singer", album: "Owned FM album", picUrl: "", interval: 240,
};

export function registerQtEntries(host: AccountMetaHost): void {
  const scopes = { meta: new Map<string, { cookie: string }>(), play: new Map<string, { cookie: string }>() };
  function scopeOf(value: unknown) {
    if (value !== "meta" && value !== "play") throw new Error("Unexpected fixture auth scope");
    return scopes[value];
  }
  async function recommend(kind: "daily" | "fm", args: Args): Promise<string> {
    const source = String(args.source);
    const session = scopes.meta.get(source);
    if (!session?.cookie) throw new Error("ACCOUNT_RECOMMENDATIONS_AUTH_REQUIRED: fixture has no meta session");
    const headers = { Cookie: session.cookie };
    function assertCurrent() {
      if (scopes.meta.get(source) !== session) throw new Error("ACCOUNT_RECOMMENDATIONS_AUTH_CHANGED: fixture session revoked");
    }
    await host.request(ACCOUNT, { headers });
    assertCurrent();
    await host.request(kind === "daily" ? DAILY : FM, { headers });
    assertCurrent();
    return JSON.stringify({ source, kind, accountId: String(args.accountId),
      items: [kind === "daily" ? DAILY_SONG : FM_SONG], fetchedAt: Date.now(), exhausted: false });
  }
  const entries: Record<string, Entry> = {
    sourceRegistry: () => JSON.stringify({ sources: [{
      id: "wyy", name: "Owned source", short: "Owned", color: "fixture",
      auth: { methods: ["cookie"], domains: ["music.163.com"] },
      accountRecommendations: { daily: true, fm: true },
    }], qualities: [], sourcePolicyVersion: 1 }),
    getSourceQualities: () => JSON.stringify({ mode: "platform", qualities: [], aliases: {} }),
    setSourcePolicy: () => JSON.stringify({ ok: true }),
    setAuth: args => {
      const scope = scopeOf(args.scope);
      const source = String(args.source);
      const cookie = String(args.cookie ?? "");
      if (cookie) scope.set(source, { cookie }); else scope.delete(source);
      return JSON.stringify({ ok: true });
    },
    clearAuth: args => {
      const scope = scopeOf(args.scope);
      if (args.source === undefined) scope.clear(); else scope.delete(String(args.source));
      return JSON.stringify({ ok: true });
    },
    accountDailySongs: args => recommend("daily", args),
    accountFmNext: args => recommend("fm", args),
  };
  (globalThis as unknown as { __qtEntries: Record<string, Entry> }).__qtEntries = entries;
}
