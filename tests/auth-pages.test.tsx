// @vitest-environment jsdom
/**
 * 新增的两个账号页面：找回密码（/forgot-password）与修改个人信息（/profile/edit）。
 *
 * 登录 / 注册的**校验规则**用例在 tests/login.validation.test.tsx（那里经真实 ipc
 * 层断言到 invoke 边界），本文件只覆盖这两个新页面自己负责的行为，重点是两条
 * 「由后端契约决定、写错会静默出错」的：
 *
 * 1. 改资料是**全量替换**：QtUpdateUserDto 的 nickname/email/avatar 都带 @NotBlank，
 *    保存资料也必须把当前头像原样回传，否则后端 400；
 * 2. 改资料成功 = 后端 `StpUtil.kickout(userId)`：本地会话必须一起清，否则界面
 *    停在「显示已登录、接口全 401」；页面也要给出「需重新登录」的去处。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const session = {
    // 对齐 AuthSession：只保留安全视图（过期时间 + 持久化模式），凭据不进 WebView
    persistence: "secure" as const,
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
    pickImage: vi.fn(async (): Promise<string | null> => "avatar.png"),
    astralUploadAvatar: vi.fn(async () => ({ url: "https://cdn.example/new-avatar.png" })),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined),
    listMyPlaylists: vi.fn(async () => []),
    getLocalTracks: vi.fn(async () => []),
    listDownloads: vi.fn(async () => []),
    likeFlushPending: vi.fn(async () => undefined),
    likeSessionEpoch: vi.fn(async () => 1),
    likeResetSync: vi.fn(async () => undefined),
    likeReconcile: vi.fn(async () => undefined),
    likeClearLocal: vi.fn(async () => undefined),
    likePull: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
    likePullAll: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
    likeApply: vi.fn(async () => undefined),
    // auth store 的收藏同步失败路径会经 @/lib/logger 落一份进文件日志
    writeLog: vi.fn(async () => undefined),
  };
});

const nav = vi.hoisted(() => ({ navigate: vi.fn(async () => undefined) }));

vi.mock("@/services/ipc", () => mocks);
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => nav.navigate,
  useRouter: () => ({ history: { back: vi.fn(), canGoBack: () => true } }),
  Link: (props: { children?: React.ReactNode; "aria-label"?: string }) => (
    <a aria-label={props["aria-label"]}>{props.children}</a>
  ),
}));
vi.mock("@/hooks/useFramelessWindow", () => ({
  useTitleBarDrag: () => ({ ref: { current: null }, onDoubleClick: vi.fn() }),
}));
vi.mock("@/components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@/components/music-source/MusicSourceSwitcher", () => ({ MusicSourceSwitcher: () => null }));
vi.mock("@/components/mine/MessagesPopover", () => ({ MessagesPopover: () => null }));

import { ForgotPasswordPage } from "@/components/mine/ForgotPasswordPage";
import { ProfileEditPage } from "@/components/mine/ProfileEditPage";
import { ProfilePage } from "@/components/mine/ProfilePage";
import { TitleBar } from "@/components/TitleBar";
import { qtresCoverUrl } from "@/lib/lrc";
import { useAuthStore } from "@/stores/auth";
import { useToastStore } from "@/stores/toast";

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
  useToastStore.setState({ items: [] });
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
    expect(mocks.astralUpdateProfile).toHaveBeenCalledWith(
      {
        nickname: "新昵称",
        email: "old@b.com",
        avatar: "https://cdn.example/a.png",
      },
      1,
    );
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

  it("选图和上传期间禁止重复提交，成功后更新头像", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    let finishPick!: (path: string | null) => void;
    let finishUpload!: (value: { url: string }) => void;
    mocks.pickImage.mockImplementationOnce(() => new Promise((resolve) => { finishPick = resolve; }));
    mocks.astralUploadAvatar.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
    const { container } = render(<ProfileEditPage />);
    const change = button(container, "更换头像");
    fireEvent.click(change);
    fireEvent.click(change);
    expect(change.disabled).toBe(true);
    await waitFor(() => expect(mocks.pickImage).toHaveBeenCalledTimes(1));
    await act(async () => finishPick("avatar.png"));
    expect(mocks.astralUploadAvatar).toHaveBeenCalledWith("avatar.png", 1);
    fireEvent.click(change);
    expect(mocks.astralUploadAvatar).toHaveBeenCalledTimes(1);
    await act(async () => finishUpload({ url: "https://cdn.example/new-avatar.png" }));
    expect(change.disabled).toBe(false);
    expect(useAuthStore.getState().profile?.avatar).toBe("https://cdn.example/new-avatar.png");
    expect(useToastStore.getState().items.at(-1)?.text).toBe("头像已更新");
  });

  it("取消选图不上传，释放按钮后可重新选择", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    mocks.pickImage.mockResolvedValueOnce(null);
    const { container } = render(<ProfileEditPage />);
    fireEvent.click(button(container, "更换头像"));
    await waitFor(() => expect(button(container, "更换头像").disabled).toBe(false));
    expect(mocks.astralUploadAvatar).not.toHaveBeenCalled();
    fireEvent.click(button(container, "更换头像"));
    await waitFor(() => expect(mocks.astralUploadAvatar).toHaveBeenCalledTimes(1));
  });

  it("头像上传成功后同步刷新编辑页、个人中心与已挂载标题栏", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    const { container, getByTestId } = render(<>
      <TitleBar />
      <div data-testid="profile"><ProfilePage /></div>
      <div data-testid="edit"><ProfileEditPage /></div>
    </>);
    const titleAvatar = container.querySelector<HTMLImageElement>('[aria-label="个人中心"] img');
    expect(titleAvatar?.getAttribute("src")).toBe(qtresCoverUrl(profile.user.avatar));
    fireEvent.click(button(getByTestId("edit"), "更换头像"));
    const expected = qtresCoverUrl("https://cdn.example/new-avatar.png");
    await waitFor(() => {
      expect(titleAvatar?.getAttribute("src")).toBe(expected);
      expect(getByTestId("profile").querySelector("img")?.getAttribute("src")).toBe(expected);
      expect(getByTestId("edit").querySelector("img")?.getAttribute("src")).toBe(expected);
    });
    expect(mocks.astralUploadAvatar).toHaveBeenCalledTimes(1);
  });

  it("选图失败有提示并释放按钮", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    mocks.pickImage.mockRejectedValueOnce(new Error("无法打开文件选择器"));
    const { container } = render(<ProfileEditPage />);
    fireEvent.click(button(container, "更换头像"));
    await waitFor(() => expect(useToastStore.getState().items.at(-1)?.text).toBe("无法打开文件选择器"));
    expect(button(container, "更换头像").disabled).toBe(false);
    expect(mocks.astralUploadAvatar).not.toHaveBeenCalled();
  });

  it("后端拒绝上传时保留原头像，不自动重试", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    mocks.astralUploadAvatar.mockRejectedValueOnce(new Error("Astral 业务错误(429): 上传并发已满，请稍后重试"));
    const { container } = render(<ProfileEditPage />);
    fireEvent.click(button(container, "更换头像"));
    await waitFor(() => expect(useToastStore.getState().items.at(-1)?.text).toBe("上传并发已满，请稍后重试"));
    expect(useAuthStore.getState().profile).toBe(profile);
    expect(button(container, "更换头像").disabled).toBe(false);
    expect(mocks.astralUploadAvatar).toHaveBeenCalledTimes(1);
  });

  it("选图期间换号不会给新账号上传", async () => {
    useAuthStore.setState({ session: mocks.session, profile });
    let finishPick!: (path: string | null) => void;
    mocks.pickImage.mockImplementationOnce(() => new Promise((resolve) => { finishPick = resolve; }));
    const { container } = render(<ProfileEditPage />);
    fireEvent.click(button(container, "更换头像"));
    await waitFor(() => expect(mocks.pickImage).toHaveBeenCalled());
    await act(async () => {
      useAuthStore.setState({ session: { ...mocks.session }, profile: { nickname: "其他账号" } });
      finishPick("avatar.png");
    });
    expect(mocks.astralUploadAvatar).not.toHaveBeenCalled();
    expect(useToastStore.getState().items).toHaveLength(0);
  });
});
