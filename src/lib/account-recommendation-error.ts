export type AccountRecommendationErrorCode =
  | "UNSUPPORTED" | "SOURCE_DISABLED" | "AUTH_REQUIRED" | "META_DISABLED" | "AUTH_EXPIRED" | "ACCOUNT_MISMATCH"
  | "AUTH_CHANGED" | "NETWORK" | "RATE_LIMIT" | "UPSTREAM" | "MALFORMED_RESPONSE"
  | "INVALID_ARGS" | "ENGINE_UNAVAILABLE" | "PACK_LOADING" | "STALE_CONTEXT" | "EMPTY";
const messages: Record<AccountRecommendationErrorCode, string> = {
  SOURCE_DISABLED: "所选音乐源已关闭，请在音源包管理中启用或选择其他推荐来源。",
  UNSUPPORTED: "当前数据包或音源不支持此账号推荐，请更新数据包或明确选择应用算法。",
  AUTH_REQUIRED: "请先在侧边栏「音源平台管理」中登录所选音源。",
  META_DISABLED: "所选音源的数据面登录授权已关闭，请在音源平台管理页中明确开启；播放面权限不会自动改变。",
  AUTH_EXPIRED: "平台登录态已失效，请重新登录所选音源账号。",
  ACCOUNT_MISMATCH: "账号推荐结果不属于当前账号，请重新登录后获取。",
  AUTH_CHANGED: "账号或数据授权已改变，旧请求已丢弃，请重新获取。",
  NETWORK: "平台账号推荐网络请求失败，请稍后重试。",
  RATE_LIMIT: "平台暂时限制请求频率，请稍后重试。",
  UPSTREAM: "平台暂时无法提供账号推荐，请稍后重试。",
  MALFORMED_RESPONSE: "平台账号推荐应答格式无效，未使用应用算法替补。",
  INVALID_ARGS: "账号推荐参数无效，请重新选择音源和账号。",
  ENGINE_UNAVAILABLE: "音源引擎尚未可用，请检查数据包后重试。",
  PACK_LOADING: "音源包正在切换，加载完成后将重新获取。",
  STALE_CONTEXT: "推荐来源、账号或音源包已改变，旧请求已丢弃。",
  EMPTY: "平台本次没有返回账号推荐歌曲，未使用应用算法补齐。",
};
export class AccountRecommendationError extends Error {
  readonly code: AccountRecommendationErrorCode;
  constructor(code: AccountRecommendationErrorCode) {
    super(messages[code]); this.name = "AccountRecommendationError"; this.code = code;
  }
}
/** Never propagate a raw engine/upstream error, URL, response body, or credential. */
export function safeAccountRecommendationError(error: unknown): AccountRecommendationError {
  if (error instanceof AccountRecommendationError) return error;
  const raw = error instanceof Error ? error.message : "";
  if (/音乐源.*关闭|平台总开关/.test(raw)) return new AccountRecommendationError("SOURCE_DISABLED");
  if (/音乐源设置/.test(raw)) return new AccountRecommendationError("STALE_CONTEXT");
  const code = raw.match(/ACCOUNT_(?:RECOMMENDATIONS_)?(UNSUPPORTED|AUTH_REQUIRED|META_DISABLED|AUTH_EXPIRED|ACCOUNT_MISMATCH|AUTH_CHANGED|NETWORK|RATE_LIMIT|UPSTREAM|MALFORMED_RESPONSE|INVALID_ARGS|ENGINE_UNAVAILABLE|PACK_LOADING|STALE_CONTEXT|EMPTY)\b/)?.[1];
  if (code && Object.prototype.hasOwnProperty.call(messages, code)) return new AccountRecommendationError(code as AccountRecommendationErrorCode);
  if (raw.includes("ACCOUNT_CHANGED")) return new AccountRecommendationError("ACCOUNT_MISMATCH");
  return new AccountRecommendationError("UPSTREAM");
}
