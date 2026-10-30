/**
 * 通知跳转地址解析（DESIGN §15.4 消息中心）。
 *
 * 后端 `sys_notice.url` 承载两类目标：
 * - `https://…` / `http://…`：外链，交系统浏览器打开（保持历史行为）；
 * - `astral://<host>/<id>`：应用内跳转，前端按白名单 host 映射到自己的路由。
 *
 * 解析不出来的一律返回 null（= 不可点）：既不 toast，也不回退成外链。
 * 这样服务端下发的任何字符串都不会变成“可导航的任意路径”（防开放重定向）。
 */

export type NoticeLink =
  | { kind: "feedback"; id: number }
  | { kind: "notice"; id: number }
  | { kind: "external"; url: string };

const ASTRAL_PREFIX = "astral://";

/** 解析失败 / 空 → null（不可点） */
export function parseNoticeLink(raw?: string | null): NoticeLink | null {
  const url = (raw ?? "").trim();
  if (url.length === 0) return null;

  if (url.startsWith(ASTRAL_PREFIX)) {
    const rest = url.slice(ASTRAL_PREFIX.length);
    // 去掉 ?/# 之后的部分（目前协议不用查询参数，留着防将来拼接）
    const path = rest.split(/[?#]/, 1)[0] ?? "";
    const seg = path.split("/").filter((s) => s.length > 0);
    if (seg.length !== 2) return null;
    const [host, rawId] = seg as [string, string];
    // 只认整数 id：`astral://feedback/abc` 这种拼错了就当不可点
    if (!/^[1-9]\d*$/.test(rawId)) return null;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) return null;
    switch (host) {
      case "feedback":
        return { kind: "feedback", id };
      case "notice":
        return { kind: "notice", id };
      default:
        // 未知 host：不可点。新增类型在两端同时加白名单后才生效
        return null;
    }
  }

  if (/^https?:\/\//i.test(url)) {
    return { kind: "external", url };
  }
  return null;
}
