import { useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import * as ipc from "@/services/ipc";
import { useAuthStore } from "@/stores/auth";

/**
 * 登录 / 注册（路由 /login，DESIGN §2.3.4）。
 * 接口契约与 qt-uniappx 一致：app/user/login 与 app/user/register，
 * 成功后后端直接返回 token（satoken），Rust 侧负责存会话并在启动时恢复。
 */
export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const loading = useAuthStore((s) => s.loading);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [tip, setTip] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setTip(null);
    if (!username.trim() || !password) {
      setTip("请填写用户名和密码");
      return;
    }
    try {
      if (mode === "login") {
        await login(username.trim(), password);
      } else {
        await register(
          username.trim(),
          password,
          email.trim() || undefined,
          code.trim() || undefined,
        );
      }
      await navigate({ to: "/profile" });
    } catch (err) {
      setTip(errMsg(err));
    }
  };

  const sendCode = async (): Promise<void> => {
    if (!email.trim()) {
      setTip("请先填写邮箱");
      return;
    }
    setTip(null);
    try {
      await ipc.astralSendEmailCode(email.trim());
      setTip("验证码已发送，请查收邮件");
    } catch (err) {
      setTip(errMsg(err));
    }
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
            placeholder="用户名"
            autoComplete="username"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="密码"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />

          {mode === "register" && (
            <>
              <div className="flex gap-2">
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="邮箱（可选）"
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => void sendCode()}
                  className="h-9 shrink-0 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary"
                >
                  发验证码
                </button>
              </div>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="邮箱验证码（可选）"
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

        <p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground">
          账号服务由 Astral 后端提供（开发环境 http://localhost:27000）。
          <br />
          后端未启动时登录会失败，不影响本地音乐与在线试听。
        </p>
      </div>
    </div>
  );
}
