// @vitest-environment jsdom
/**
 * 新增的两个账号页面：找回密码（/forgot-password）与修改个人信息（/profile/edit）。
 *
 * 登录 / 注册的**校验规则**用例在 tests/login.validation.test.tsx（那里经真实 ipc
 * 层断言到 invoke 边界），本文件只覆盖这两个新页面自己负责的行为，重点是两条
 * 「由后端契约决定、写错会静默出错」的：
 *
 * 1. 改资料是**全量替换**：QtUpdateUserDto 的 nickname/email/avatar 都带 @NotBlank，
 *    本期不做头像上传也必须把当前头像原样回传，否则后端 400；
 * 2. 改资料成功 = 后端 `StpUtil.kickout(userId)`：本地会话必须一起清，否则界面
 *    停在「显示已登录、接口全 401」；页面也要给出「需重新登录」的去处。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const session = {
    token: "t-1",
    // 对齐 AuthSession：refreshToken 是不可空 string（后端不给时回空串）
    refreshToken: "",
    expiresAt: Date.now() + 3 * 24 * 3600 * 1000,
  };
  return {
    session,
    astralLogin: vi.fn(async () => session),
    astralRegister: vi.fn(async () => session),
    astralSession: vi.fn(async () => session),
    astralMe: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    astralLogout: vi.fn(async () => undefined),
    astralUpdateProfile: vi.fn(async () => ({})),
    astralSendEmailCode: vi.fn(async () => ({})),
    astralChangePassword: vi.fn(async () => ({})),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined),
    likeFlushPending: vi.fn(async () => undefined),
    likeResetSync: vi.fn(async () => undefined),
    likeReconcile: vi.fn(async () => undefined),
    likeClearLocal: vi.fn(async () => undefined),
    likePull: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
    likePullAll: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
    likeApply: vi.fn(async () => undefined),
  };
});

const nav = vi.hoisted(() => ({ navigate: vi.fn(async () => undefined) }));

vi.mock("@/services/ipc", () => mocks);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav.navigate }));

import { ForgotPasswordPage } from "@/components/mine/ForgotPasswordPage";
import { ProfileEditPage } from "@/components/mine/ProfileEditPage";
import { useAuthStore } from "@/stores/auth";

/** 按 placeholder 片段找输入框 */
function field(container: HTMLElement, placeholder: string): HTMLInputElement {
  const el = [...container.querySelectorAll("input")].find((i) =>
    (i.placeholder ?? "").includes(placeholder),
  );
  if (!el) throw new Error(`找不到输入框：${placeholder}`);
  return el as HTMLInputElement;
}

/** 按文字找按钮（精确匹配，避免「注册」命中「注册并登录」） */
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!el) throw new Error(`找不到按钮：${text}`);
  return el as HTMLButtonElement;
}

function fill(container: HTMLElement, placeholder: string, value: string): void {
  fireEvent.change(field(container, placeholder), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ session: null, profile: null, loading: false, error: null });
});

describe("找回密码页", () => {
  it("发送验证码 → 冷却倒计时 → 用验证码重置并回到登录页", async () => {
    const { container } = render(<ForgotPasswordPage />);
    fill(container, "注册时填的邮箱", "a@b.com");
    fireEvent.click(button(container, "发送验证码"));

    await waitFor(() => expect(mocks.astralSendEmailCode).toHaveBeenCalledWith("a@b.com"));
    // 后端同一邮箱 60 秒内只能发一次：发出去后按钮进冷却，别让用户连点白挨报错
    await waitFor(() => expect(container.textContent).toContain("后重发"));

    fill(container, "6 位验证码", "123456");
    fill(container, "新密码", "newpass1");
    fill(container, "确认新密码", "newpass1");
    fireEvent.click(button(container, "重置密码"));

    await waitFor(() =>
      expect(mocks.astralChangePassword).toHaveBeenCalledWith("a@b.com", "newpass1", "123456"),
    );
    // 改密后后端 kickout 全部会话：只能回登录页，不能假装还登录着
    await waitFor(() => expect(container.textContent).toContain("密码已重置"));
  });

  it("验证码为空时不提交（省一次必然失败的服务端往返）", async () => {
    const { container } = render(<ForgotPasswordPage />);
    fill(container, "注册时填的邮箱", "a@b.com");
    fill(container, "新密码", "newpass1");
    fill(container, "确认新密码", "newpass1");
    fireEvent.click(button(container, "重置密码"));

    await waitFor(() => expect(container.textContent).toContain("请填写邮箱验证码"));
    expect(mocks.astralChangePassword).not.toHaveBeenCalled();
  });
});

describe("修改个人信息页", () => {
  const profile = {
    roles: [] as string[],
    user: {
      id: 7,
      username: "quiet_user",
      nickname: "旧昵称",
      email: "old@b.com",
      avatar: "https://cdn.example/a.png",
    },
  };

  it("预填当前昵称/邮箱；保存时把当前头像原样回传（后端 @NotBlank 必填）", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    const { container } = render(<ProfileEditPage />);

    expect(field(container, "昵称").value).toBe("旧昵称");
    expect(field(container, "邮箱").value).toBe("old@b.com");

    fill(container, "昵称", "新昵称");
    fireEvent.click(button(container, "保存"));

    await waitFor(() => expect(mocks.astralUpdateProfile).toHaveBeenCalled());
    expect(mocks.astralUpdateProfile).toHaveBeenCalledWith({
      nickname: "新昵称",
      email: "old@b.com",
      avatar: "https://cdn.example/a.png",
    });
  });

  it("保存成功后清本地会话并提示重新登录（后端 kickout 的配套处理）", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    const { container } = render(<ProfileEditPage />);
    fireEvent.click(button(container, "保存"));

    await waitFor(() => expect(useAuthStore.getState().session).toBeNull());
    await waitFor(() => expect(container.textContent).toContain("资料已更新"));
    expect(mocks.astralLogout).toHaveBeenCalled();
  });

  it("改密码时补上确认校验；留空 = 不改密码，确认框不出现", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    const { container } = render(<ProfileEditPage />);
    expect(
      [...container.querySelectorAll("input")].some((i) =>
        (i.placeholder ?? "").includes("再次输入"),
      ),
    ).toBe(false);

    fill(container, "留空不改", "newpass1");
    fill(container, "再次输入", "different");
    fireEvent.click(button(container, "保存"));

    await waitFor(() => {
      expect(container.textContent).toContain("两次输入的密码不一致");
    });
    expect(mocks.astralUpdateProfile).not.toHaveBeenCalled();
  });

  it("未登录：给去登录入口，不渲染表单", () => {
    const { container } = render(<ProfileEditPage />);
    expect(container.textContent).toContain("未登录");
    expect([...container.querySelectorAll("input")].length).toBe(0);
  });
});
