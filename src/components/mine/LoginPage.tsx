import { useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth";

/**
 * 登录 / 注册（路由 /login，DESIGN §2.3.4）。
 * 接口契约与 qt-uniappx 一致：app/user/login 与 app/user/register，
 * 成功后后端直接返回 token（satoken），Rust 侧负责存会话并在启动时恢复。
 */

/**
 * 错误提示：不把服务端地址、内部实现细节抛到界面上。
 * Rust 侧错误串形如「Astral 业务错误(500): 用户名或密码错误」或
 * 「Astral 请求失败: error sending request for url (http://…)」——
 * 前者只保留业务文案，后者统一成网络提示（reqwest 的错误串里带 URL）。
 */
function authTip(err: unknown): string {
  const raw = errMsg(err);
  const biz = /业务错误\(\d+\)[:：]\s*(.+)$/.exec(raw);
  if (biz && biz[1].trim().length > 0) return biz[1].trim();
  if (/https?:\/\//i.test(raw) || /请求失败|响应解析失败|error sending request/i.test(raw)) {
    return "网络异常，请稍后重试";
  }
  return raw;
}
/** 注册校验规则：用户名 5-18 位英文/数字；密码 6-18 位（上限对齐后端 QtRegisterDto） */
const USERNAME_RE = /^[A-Za-z0-9]{5,18}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 18;
/** 邮箱格式：够用即可，不做 RFC 级别的严格匹配 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const loading = useAuthStore((s) => s.loading);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [tip, setTip] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setTip(null);
    const name = username.trim();
    if (!name || !password) {
      setTip("请填写用户名和密码");
      return;
    }
    if (mode === "register") {
      // 注册规则本地先挡一遍，不用等后端往返
      if (!USERNAME_RE.test(name)) {
        setTip("用户名需为 5-18 位英文或数字");
        return;
      }
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        setTip(`密码需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 位`);
        return;
      }
      if (password !== confirm) {
        setTip("两次输入的密码不一致");
        return;
      }
      const mail = email.trim();
      if (!mail) {
        setTip("请填写邮箱");
        return;
      }
      if (!EMAIL_RE.test(mail)) {
        setTip("邮箱格式不正确");
        return;
      }
      try {
        await register(name, password, confirm, mail);
      } catch (err) {
        setTip(authTip(err));
        return;
      }
    } else {
      try {
        await login(name, password);
      } catch (err) {
        setTip(authTip(err));
        return;
      }
    }
    await navigate({ to: "/profile" });
  };

  if (session) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm">当前已登录</p>
          <button
            type="button"
            onClick={() => void navigate({ to: "/profile" })}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            进入个人中心
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-lg font-semibold">轻听</h1>
        <p className="mt-1 text-center text-xs text-muted-foreground">
          登录后可同步收藏、消息与反馈
        </p>

        <div className="mt-5 flex rounded-md bg-secondary p-1">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setTip(null);
              }}
              className={`flex-1 rounded px-3 py-1.5 text-xs transition-colors ${
                mode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground"
              }`}
            >
              {m === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-3">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={mode === "login" ? "用户名" : "用户名（5-18 位英文或数字）"}
            autoComplete="username"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder={mode === "login" ? "密码" : "密码（至少 6 位）"}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />

          {mode === "register" && (
            <>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                type="password"
                placeholder="确认密码"
                autoComplete="new-password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                placeholder="邮箱"
                autoComplete="email"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading}
            className="h-9 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "处理中…" : mode === "login" ? "登 录" : "注册并登录"}
          </button>

          {tip && (
            <p className="text-center text-xs text-destructive">{tip}</p>
          )}
        </div>
      </div>
    </div>
  );
}
