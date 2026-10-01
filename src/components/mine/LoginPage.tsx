import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth";
import {
  AuthButton,
  AuthInput,
  AuthShell,
  AuthTabs,
  AuthTip,
  EyeToggle,
} from "@/components/mine/auth-ui";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  authTip,
  checkConfirm,
  checkEmail,
  checkLoginAccount,
  checkPassword,
  checkUsername,
} from "@/lib/auth-tip";

/**
 * 登录 / 注册（路由 /login）。
 *
 * 契约对齐后端 astral-plugin（QtAppUserController + QtUserService）：
 * - 登录 app/user/login：`username` 字段**同时接受用户名与邮箱**，成功直接回 token；
 * - 注册 app/user/register：用户名 3-30、密码 6-18、两次一致、邮箱必填、昵称选填
 *   （昵称留空时后端默认用用户名）；
 * - 校验规则一律与后端 DTO 对齐（见 lib/auth-tip），本地不做比后端更严的拦截。
 */
type Mode = "login" | "register";

export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const loading = useAuthStore((s) => s.loading);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [tip, setTip] = useState<string | null>(null);

  const switchMode = (m: Mode): void => {
    setMode(m);
    setTip(null);
  };

  const submit = async (): Promise<void> => {
    setTip(null);
    const name = username.trim();

    if (mode === "login") {
      // 登录侧只校验非空：后端 QtLoginDto 对密码没有长度限制，账号字段还接受邮箱
      // （邮箱长度普遍超过 30），套注册那套规则会把能登的账号拦在本地。
      const bad = checkLoginAccount(name) ?? (password ? null : "请填写密码");
      if (bad) {
        setTip(bad);
        return;
      }
      try {
        await login(name, password);
      } catch (err) {
        setTip(authTip(err));
        return;
      }
      await navigate({ to: "/profile" });
      return;
    }

    const bad =
      checkUsername(name) ??
      checkEmail(email) ??
      checkPassword(password) ??
      checkConfirm(password, confirm);
    if (bad) {
      setTip(bad);
      return;
    }
    try {
      await register(name, password, confirm, email.trim(), nickname.trim());
    } catch (err) {
      setTip(authTip(err));
      return;
    }
    await navigate({ to: "/profile" });
  };

  if (session) {
    return (
      <AuthShell title="轻听" subtitle="当前已登录">
        <AuthButton label="进入个人中心" onClick={() => void navigate({ to: "/profile" })} />
      </AuthShell>
    );
  }

  const pwToggle = <EyeToggle shown={showPw} onToggle={() => setShowPw((v) => !v)} />;

  return (
    <AuthShell title="轻听" subtitle="登录后可同步收藏、消息与反馈">
      <AuthTabs
        value={mode}
        onChange={switchMode}
        items={[
          { value: "login", label: "登录" },
          { value: "register", label: "注册" },
        ]}
      />

      <div className="space-y-3">
        <AuthInput
          value={username}
          onChange={setUsername}
          placeholder={
            mode === "login" ? "用户名或邮箱" : `用户名（${USERNAME_MIN}-${USERNAME_MAX} 个字符）`
          }
          autoComplete="username"
          onEnter={() => void submit()}
        />

        {mode === "register" ? (
          <>
            <AuthInput
              value={nickname}
              onChange={setNickname}
              placeholder="昵称（选填，默认同用户名）"
              // 仅输入上限：后端对昵称没有长度校验，这里按用户名的量级挡一下超长粘贴
              maxLength={USERNAME_MAX}
              onEnter={() => void submit()}
            />
            <AuthInput
              value={email}
              onChange={setEmail}
              placeholder="邮箱（用于找回密码）"
              type="email"
              autoComplete="email"
              onEnter={() => void submit()}
            />
          </>
        ) : null}

        <AuthInput
          value={password}
          onChange={setPassword}
          placeholder={mode === "login" ? "密码" : `密码（${PASSWORD_MIN}-${PASSWORD_MAX} 位）`}
          type={showPw ? "text" : "password"}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          maxLength={PASSWORD_MAX}
          onEnter={() => void submit()}
          action={pwToggle}
        />

        {mode === "register" ? (
          <AuthInput
            value={confirm}
            onChange={setConfirm}
            placeholder="确认密码"
            // 与上面共用一个显隐开关：一次点开两个都看得见，省得来回切
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX}
            onEnter={() => void submit()}
          />
        ) : null}

        <AuthButton
          label={mode === "login" ? "登 录" : "注册并登录"}
          busyLabel="处理中…"
          busy={loading}
          onClick={() => void submit()}
        />

        <AuthTip tip={tip} />

        {mode === "login" ? (
          <div className="text-center">
            <button
              type="button"
              onClick={() => void navigate({ to: "/forgot-password" })}
              className="cursor-pointer text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
            >
              忘记密码？
            </button>
          </div>
        ) : (
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
            注册后可用该邮箱重置密码，请填真实邮箱
          </p>
        )}
      </div>
    </AuthShell>
  );
}
