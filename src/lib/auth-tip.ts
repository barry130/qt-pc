import { errMsg } from "@/lib/utils";

/**
 * 认证类页面的报错文案与本地校验规则（登录/注册、找回密码、改资料共用）。
 *
 * 校验规则**必须与后端 DTO 对齐，且不得比后端更严**：本地多拦一刀，用户拿到的
 * 是「填什么都过不去」而没有任何服务端解释。历史上这里就踩过：前端写死
 * `^[A-Za-z0-9]{5,18}$`，而后端 QtRegisterDto/QtLoginDto 都是 @Size(min=3, max=30)
 * 且不限字符集 —— 后端允许的 3-4 位、19-30 位账号在本地就被拦死了。
 */

/** 与后端 QtRegisterDto / QtLoginDto 的 @Size 一致 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
/** 与后端 @Size(min=6, max=18)（注册、改密码、改资料三处一致） */
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 18;
/** 邮箱格式：够用即可，不做 RFC 级别的严格匹配（后端用 @Email，同样宽松） */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 错误提示：不把服务端地址、内部实现细节抛到界面上。
 * Rust 侧错误串形如「Astral 业务错误(500): 用户名或密码错误」或
 * 「Astral 请求失败: error sending request for url (http://…)」——
 * 前者只保留业务文案，后者统一成网络提示（reqwest 的错误串里带 URL）。
 */
export function authTip(err: unknown): string {
  const raw = errMsg(err);
  const biz = /业务错误\(\d+\)[:：]\s*(.+)$/.exec(raw);
  if (biz && biz[1].trim().length > 0) return biz[1].trim();
  if (/https?:\/\//i.test(raw) || /请求失败|响应解析失败|error sending request/i.test(raw)) {
    return "网络异常，请稍后重试";
  }
  return raw;
}

/** 注册用：用户名长度校验（返回 null = 通过） */
export function checkUsername(name: string): string | null {
  const n = name.trim();
  if (!n) return "请填写用户名";
  if (n.length < USERNAME_MIN || n.length > USERNAME_MAX) {
    return `用户名需为 ${USERNAME_MIN}-${USERNAME_MAX} 个字符`;
  }
  return null;
}

/**
 * 登录用：账号只校验非空。
 *
 * 后端登录接口的 `username` 字段同时接受**用户名和邮箱**
 * （QtUserService.login：username = ? OR email = ?），邮箱长度普遍超过 30，
 * 套注册那套长度规则会把邮箱登录直接拦死。
 */
export function checkLoginAccount(name: string): string | null {
  return name.trim() ? null : "请填写用户名或邮箱";
}

/** 密码长度校验（注册 / 重置 / 改资料共用；返回 null = 通过） */
export function checkPassword(pw: string): string | null {
  if (!pw) return "请填写密码";
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
    return `密码需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 位`;
  }
  return null;
}

/** 邮箱校验（返回 null = 通过） */
export function checkEmail(mail: string): string | null {
  const m = mail.trim();
  if (!m) return "请填写邮箱";
  if (!EMAIL_RE.test(m)) return "邮箱格式不正确";
  return null;
}

/** 两次密码一致性（返回 null = 通过） */
export function checkConfirm(pw: string, confirm: string): string | null {
  return pw === confirm ? null : "两次输入的密码不一致";
}
