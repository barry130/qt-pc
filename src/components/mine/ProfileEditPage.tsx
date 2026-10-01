import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Info } from "lucide-react";
import { avatarUrl, displayName, useAuthStore } from "@/stores/auth";
import { AuthButton, AuthInput, AuthTip, EyeToggle } from "@/components/mine/auth-ui";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  authTip,
  checkConfirm,
  checkEmail,
  checkPassword,
} from "@/lib/auth-tip";
import { qtresCoverUrl } from "@/lib/lrc";
import * as ipc from "@/services/ipc";

/**
 * 修改个人信息（路由 /profile/edit）。
 *
 * 后端 QtUpdateUserDto 是**全量替换**：nickname / email / avatar 都带 @NotBlank，
 * 只改昵称也必须把三项一起上送，否则后端校验直接 400。
 * 头像不走这里：它有独立的两段直传接口（ticket → 客户端直传存储端 → complete，
 * UPDATE_DESIGN.md §5.2），后端直接写 sys_user.avatar，不触发踢下线。
 *
 * 一个必须写进界面的后端行为：QtUserService.updateUser 结尾会
 * `StpUtil.kickout(userId)`——**改完资料所有端都被强制下线**。所以保存前先告知
 * 「保存后需重新登录」，保存成功后回登录页，而不是留在原地装成还登录着。
 */
export function ProfileEditPage(): React.JSX.Element {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const profile = useAuthStore((s) => s.profile);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const setLocalAvatar = useAuthStore((s) => s.setLocalAvatar);

  const [nickname, setNickname] = useState(() => displayName(profile, ""));
  const [email, setEmail] = useState(() => readStr(profile, ["email"]));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [tip, setTip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const avatar = avatarUrl(profile);
  const avatarSrc = avatar ? qtresCoverUrl(avatar) : null;

  /** 换头像：选图 → 直传一条龙 → 只改本地展示态（URL 即版本，天然破缓存） */
  const changeAvatar = async (): Promise<void> => {
    setTip(null);
    const path = await ipc.pickImage("选择头像图片");
    if (!path) return;
    setAvatarBusy(true);
    try {
      const { url } = await ipc.astralUploadAvatar(path);
      setLocalAvatar(url);
      setTip("头像已更新");
    } catch (err) {
      setTip(authTip(err));
    } finally {
      setAvatarBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setTip(null);
    const name = nickname.trim();
    if (!name) {
      setTip("请填写昵称");
      return;
    }
    const bad = checkEmail(email);
    if (bad) {
      setTip(bad);
      return;
    }
    if (password) {
      const pwBad = checkPassword(password) ?? checkConfirm(password, confirm);
      if (pwBad) {
        setTip(pwBad);
        return;
      }
    }
    setBusy(true);
    try {
      await updateProfile({
        nickname: name,
        email: email.trim(),
        // 头像本期不改：后端 @NotBlank 必填，原样回传当前值
        avatar,
        ...(password ? { password } : {}),
      });
      setDone(true);
    } catch (err) {
      setTip(authTip(err));
    } finally {
      setBusy(false);
    }
  };

  // 保存成功优先于「未登录」判断：updateProfile 成功后会清掉本地会话（后端踢人），
  // 若先判未登录就会把成功态顶掉，用户只看到被踢回登录页而不知道发生了什么。
  if (done) {
    return (
      <PageShell>
        <section className="relative overflow-hidden rounded-2xl border border-border bg-card/60 p-5">
          <h2 className="text-sm font-semibold">资料已更新</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            出于安全考虑，修改资料后需要重新登录（后端会注销当前会话）。
          </p>
          <div className="mt-4">
            <AuthButton label="去登录" onClick={() => void navigate({ to: "/login" })} />
          </div>
        </section>
      </PageShell>
    );
  }

  if (!session) {
    return (
      <PageShell>
        <section className="rounded-2xl border border-border bg-card/60 p-5">
          <h2 className="text-sm font-semibold">未登录</h2>
          <p className="mt-1.5 text-xs text-muted-foreground">登录后才能修改个人信息。</p>
          <div className="mt-4">
            <AuthButton label="去登录" onClick={() => void navigate({ to: "/login" })} />
          </div>
        </section>
      </PageShell>
    );
  }

  const pwToggle = <EyeToggle shown={showPw} onToggle={() => setShowPw((v) => !v)} />;

  return (
    <PageShell>
      <section className="relative overflow-hidden rounded-2xl border border-border bg-card/60 p-5">
        {/* 头像：选图后 Rust 直传存储端，登记成功立刻更新本地展示 */}
        <div className="flex items-center gap-4">
          <div className="shrink-0 rounded-full ring-1 ring-border">
            <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-secondary">
              <img
                src={avatarSrc ?? "/static/icon/xxxhdpi.png"}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">头像</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              支持 png / jpg / webp，每天最多上传 2 次
            </div>
          </div>
          <div className="shrink-0">
            <AuthButton
              label="更换头像"
              busyLabel="上传中…"
              busy={avatarBusy}
              variant="ghost"
              onClick={() => void changeAvatar()}
            />
          </div>
        </div>

        <div className="mt-5 space-y-3">
          <Labeled label="昵称">
            <AuthInput
              value={nickname}
              onChange={setNickname}
              placeholder="昵称"
              onEnter={() => void save()}
            />
          </Labeled>

          <Labeled label="邮箱">
            <AuthInput
              value={email}
              onChange={setEmail}
              placeholder="邮箱"
              type="email"
              autoComplete="email"
              onEnter={() => void save()}
            />
          </Labeled>

          <Labeled label="新密码" hint="留空表示不修改">
            <AuthInput
              value={password}
              onChange={setPassword}
              placeholder={`${PASSWORD_MIN}-${PASSWORD_MAX} 位，留空不改`}
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX}
              onEnter={() => void save()}
              action={pwToggle}
            />
          </Labeled>

          {password ? (
            <Labeled label="确认新密码">
              <AuthInput
                value={confirm}
                onChange={setConfirm}
                placeholder="再次输入新密码"
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                maxLength={PASSWORD_MAX}
                onEnter={() => void save()}
              />
            </Labeled>
          ) : null}
        </div>

        {/* 保存前就把「会被踢下线」说清楚，别让用户在登录页一脸茫然 */}
        <p className="mt-4 flex items-start gap-1.5 rounded-lg bg-secondary/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          保存后当前账号会退出登录，需要用新密码重新登录。
        </p>

        <div className="mt-4 flex items-center gap-2">
          <div className="flex-1">
            <AuthButton label="保存" busyLabel="保存中…" busy={busy} onClick={() => void save()} />
          </div>
          <div className="flex-1">
            <AuthButton
              label="取消"
              variant="ghost"
              onClick={() => void navigate({ to: "/profile" })}
            />
          </div>
        </div>

        <div className="mt-3">
          <AuthTip tip={tip} />
        </div>
      </section>
    </PageShell>
  );
}

/** 应用内页面外壳：与个人中心同一套标题 + 返回语言 */
function PageShell(props: { children: React.ReactNode }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="px-5 pb-2 pt-6">
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void navigate({ to: "/profile" })}
            aria-label="返回"
            title="返回"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-base font-semibold">修改个人信息</h1>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** 带标签的表单行（标签在输入框上方，和全站表单一致） */
function Labeled(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="text-xs font-medium">{props.label}</span>
        {props.hint ? (
          <span className="text-[11px] text-muted-foreground">{props.hint}</span>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

/**
 * 从 me 的响应里读一个字符串字段。
 * 后端字段挂在顶层（QtUserInfoVo）或嵌套 user（User 实体）上都兼容。
 */
function readStr(profile: Record<string, unknown> | null, keys: string[]): string {
  const user = profile?.user as Record<string, unknown> | null | undefined;
  for (const source of [profile, user]) {
    if (!source) continue;
    for (const key of keys) {
      const v = source[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}
