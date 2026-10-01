/**
 * 意见反馈数据层（查询 / 详情 / 回复）。
 *
 * 对齐后端 astral-plugin-feedback 的 App 端接口（/api/v1/app/feedback/**，
 * QtRestResp 已在 Rust astral 客户端解包，这里拿到的就是 data）：
 * - 列表是 MyBatis-Plus Page 序列化：{ records, total, current, pages }；
 * - 类型枚举 = Feedback.TYPE_ISSUE("issue") / TYPE_REQUEST("request")，
 *   normalizeType 只认这两个值；
 * - 状态机：pending提出 → received已接收 → resolved已解决 → published已发布，
 *   任意状态可 → deprecated已废弃。
 * 与移动端（qt-uniappx services/feedback.ts）同一套口径。
 */

/** 分页默认条数（与移动端 FEEDBACK_PAGE_SIZE 一致） */
export const FEEDBACK_PAGE_SIZE = 10;

/** 反馈条目（sys_feedback；后端可空字段统一规整成默认值，页面免空判断） */
export interface FeedbackItem {
  id: number;
  /** 类型：issue 问题 | request 需求 */
  type: string;
  title: string;
  content: string;
  contact: string;
  /** pending | received | resolved | published | deprecated */
  status: string;
  /** 是否公开（published 且公开的才出现在公开列表；公开后不可再回复） */
  isPublic: boolean;
  /** 设备型号（服务端从请求头补） */
  device: string;
  /** 系统版本 */
  os: string;
  /** App 版本 */
  appVersion: string;
  /** 平台：windows | android | ios */
  platform: string;
  createTime: string;
  updateTime: string;
}

/** 反馈回复（sys_feedback_reply；nickname/userType 为后端 JOIN sys_user 填充） */
export interface FeedbackReplyItem {
  id: number;
  feedbackId: number;
  content: string;
  replyTime: string;
  /** 发送者昵称 */
  nickname: string;
  /** ADMIN 官方 | APP 用户 */
  userType: string;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 后端字段可空：规整成带默认值的完整对象（与移动端 normalizeFeedback 同口径） */
export function normalizeFeedback(raw: unknown): FeedbackItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: num(r.id),
    type: str(r.type, "issue"),
    title: str(r.title),
    content: str(r.content),
    contact: str(r.contact),
    status: str(r.status, "pending"),
    isPublic: r.isPublic === true,
    device: str(r.device),
    os: str(r.os),
    appVersion: str(r.appVersion),
    platform: str(r.platform),
    createTime: str(r.createTime),
    updateTime: str(r.updateTime),
  };
}

export function normalizeReply(raw: unknown): FeedbackReplyItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: num(r.id),
    feedbackId: num(r.feedbackId),
    content: str(r.content),
    replyTime: str(r.replyTime),
    nickname: str(r.nickname),
    userType: str(r.userType),
  };
}

/** 分页响应规整；records 非数组时按空列表处理 */
export function normalizePage(raw: unknown): { records: FeedbackItem[]; total: number } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(r.records) ? r.records : [];
  return {
    records: list.map((item) => normalizeFeedback(item)),
    total: num(r.total),
  };
}

/** 类型标签文案：issue 问题 | request 需求（与移动端一致，未知值按问题处理） */
export function feedbackTypeLabel(type: string): string {
  return type === "request" ? "需求" : "问题";
}

/** 类型徽标配色 */
export function feedbackTypeClass(type: string): string {
  return type === "request" ? "bg-orange-500/15 text-orange-500" : "bg-blue-500/15 text-blue-500";
}

/** 状态中文名（pending 默认「提出」） */
export function feedbackStatusLabel(status: string): string {
  if (status === "received") return "已接收";
  if (status === "resolved") return "已解决";
  if (status === "published") return "已发布";
  if (status === "deprecated") return "已废弃";
  return "提出";
}

/** 状态徽标配色：提出琥珀 / 已接收蓝 / 已解决绿 / 已发布紫 / 已废弃灰 */
export function feedbackStatusClass(status: string): string {
  if (status === "received") return "bg-blue-500/15 text-blue-500";
  if (status === "resolved") return "bg-emerald-500/15 text-emerald-500";
  if (status === "published") return "bg-purple-500/15 text-purple-500";
  if (status === "deprecated") return "bg-zinc-500/15 text-zinc-500";
  return "bg-amber-500/15 text-amber-500";
}

/** 回复时间线头像字符：昵称首字，官方无昵称兜底「官」 */
export function feedbackAvatarChar(nickname: string, userType: string): string {
  const n = nickname.trim();
  if (n.length > 0) return n.charAt(0);
  return userType === "ADMIN" ? "官" : "用";
}

/**
 * 时间显示：后端给「YYYY-MM-DD HH:mm:ss」，取「MM-DD HH:mm」
 * （与移动端 formatTime 同口径；长度不足原样返回）。
 */
export function formatFeedbackTime(t: string): string {
  return t.length >= 16 ? t.substring(5, 16) : t;
}
