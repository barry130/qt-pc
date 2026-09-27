import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth";
import { AuthButton, AuthInput, AuthShell, AuthTip, EyeToggle } from "@/components/mine/auth-ui";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  authTip,
  checkConfirm,
  checkEmail,
  checkPassword,
} from "@/lib/auth-tip";

/**
 * 找回密码（路由 /forgot-password）：邮箱验证码重置密码。
 *
 * 契约对齐后端 QtAppUserController + QtUserService：
 * - `app/user/email`：发验证码。后端按「邮箱 + 邮件模板 scene」做 60 秒频控，
 *   验证码 10 分钟有效；同一收件人每天还有封数上限（种子数据 daily_limit = 2）。
 * - `app/user/changePass`：校验验证码并改密码，成功后 kickout 该用户全部会话。
 *
 * 两个后端行为决定了本页文案，写错会让用户白试：
 * 1. 验证码只发给**已注册的 App 用户邮箱**，未注册邮箱直接报「当前邮箱不在系统中」——
 *    所以提示语写「注册时填的邮箱」，而不是含糊的「你的邮箱」；
 * 2. 改密码成功 = 所有端被踢下线，所以成功后回登录页，不假装还登录着。
 */

/** 发送后的冷却秒数，与后端 60 秒频控对齐 */
const RESEND_COOLDOWN_S = 60;

export function ForgotPasswordPage(): React.JSX.Element {
  const navigate = useNavigate();
  const sendEmailCode = useAuthStore((s) => s.sendEmailCode);
  const changePassword = useAuthStore((s) => s.changePassword);

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [tip, setTip] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [done, setDone] = useState(false);

  // 冷却倒计时（后端 60 秒内重发会直接报「发送过于频繁」）
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((v) => v - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // 成功页停一下再回登录页；用户也可以直接点按钮走
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => void navigate({ to: "/login" }), 2500);
    return () => window.clearTimeout(timer);
  }, [done, navigate]);

  const send = async (): Promise<void> => {
    setTip(null);
    setOk(null);
    const bad = checkEmail(email);
    if (bad) {
      setTip(bad);
      return;
    }
    setSending(true);
    try {
      await sendEmailCode(email.trim());
      setOk(`验证码已发送到 ${email.trim()}，10 分钟内有效`);
      setCooldown(RESEND_COOLDOWN_S);
    } catch (err) {
      setTip(authTip(err));
    } finally {
      setSending(false);
    }
  };

  const submit = async (): Promise<void> => {
    setTip(null);
    const bad =
      checkEmail(email) ??
      (code.trim() ? null : "请填写邮箱验证码") ??
      checkPassword(password) ??
      checkConfirm(password, confirm);
    if (bad) {
      setTip(bad);
      return;
    }
    setBusy(true);
    try {
      await changePassword(email.trim(), password, code.trim());
      setDone(true);
    } catch (err) {
      setTip(authTip(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthShell title="密码已重置" subtitle="该账号在所有设备上都已退出登录">
        <AuthTip tip="请用新密码重新登录" kind="ok" />
        <AuthButton label="去登录" onClick={() => void navigate({ to: "/login" })} />
      </AuthShell>
    );
  }

  const pwToggle = <EyeToggle shown={showPw} onToggle={() => setShowPw((v) => !v)} />;

  return (
    <AuthShell title="找回密码" subtitle="用注册时填的邮箱接收验证码">
      <div className="space-y-3">
        <AuthInput
          value={email}
          onChange={setEmail}
          placeholder="注册时填的邮箱"
          type="email"
          autoComplete="email"
          onEnter={() => void submit()}
        />

        {/* 验证码 + 发送按钮同一行：发送是这一行的动作，不该另起一段 */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <AuthInput
              value={code}
              onChange={setCode}
              placeholder="6 位验证码"
              maxLength={6}
              onEnter={() => void submit()}
            />
          </div>
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || cooldown > 0}
            className="h-9 shrink-0 cursor-pointer rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "发送中…" : cooldown > 0 ? `${cooldown}s 后重发` : "发送验证码"}
          </button>
        </div>

        <AuthInput
          value={password}
          onChange={setPassword}
          placeholder={`新密码（${PASSWORD_MIN}-${PASSWORD_MAX} 位）`}
          type={showPw ? "text" : "password"}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX}
          onEnter={() => void submit()}
          action={pwToggle}
        />
        <AuthInput
          value={confirm}
          onChange={setConfirm}
          placeholder="确认新密码"
          type={showPw ? "text" : "password"}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX}
          onEnter={() => void submit()}
        />

        <AuthButton
          label="重置密码"
          busyLabel="提交中…"
          busy={busy}
          onClick={() => void submit()}
        />

        <AuthTip tip={tip} />
        <AuthTip tip={ok} kind="ok" />

        <div className="text-center">
          <button
            type="button"
            onClick={() => void navigate({ to: "/login" })}
            className="cursor-pointer text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
          >
            返回登录
          </button>
        </div>
      </div>
    </AuthShell>
  );
}
