// @vitest-environment jsdom
/**
 * 登录 / 注册表单的本地校验（经真实 ipc 层断言到 invoke 边界）。
 *
 * 规则**必须与后端 DTO 对齐**（astral-plugin 的 QtLoginDto / QtRegisterDto）：
 * - 注册：用户名 @Size(min=3, max=30) 且不限字符集；密码 @Size(min=6, max=18)；
 *   两次一致；邮箱 @Email 必填；昵称选填（留空时后端默认用用户名）；
 * - 登录：`username` 字段**同时接受用户名与邮箱**（QtUserService.login 用
 *   `username = ? OR email = ?` 查），密码只要求非空（QtLoginDto 对密码无 @Size）。
 *
 * 历史教训：这里以前锁的是「用户名 5-18 位英文/数字」——那是前端自己加的规则，
 * 比后端更严，后端允许的 3-4 位、19-30 位、含下划线的账号全被本地拦死，
 * 用户只会看到「怎么填都过不去」而没有任何服务端解释。校验一律以服务端为准。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ token: "t", expiresIn: 3600 })),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { LoginPage } from "@/components/mine/LoginPage";
import { useAuthStore } from "@/stores/auth";

const invokeMock = vi.mocked(invoke);

/**
 * 每个用例都从「未登录」开始。
 *
 * auth store 是模块级单例，同一个文件里的用例共享它：只要有一条用例**真的**注册/
 * 登录成功（下面「19 位用户名放行」就是故意的），后面的 render(<LoginPage/>) 会直接
 * 进「当前已登录」分支，连注册 tab 都找不到 —— 排查时特别容易被误导成"校验坏了"。
 */
function resetAuth(): void {
  useAuthStore.setState({ session: null, profile: null, loading: false, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAuth();
});

// vitest 未开 globals，RTL 不会自动清理；不清会把上一条用例的 DOM 一起查出来
afterEach(() => {
  cleanup();
  resetAuth();
});

/**
 * 按 placeholder **片段**取输入框。
 * 用片段而不是全等：文案会随提示语调整，用例不该跟着一起碎。
 */
function field(container: HTMLElement, placeholder: string): HTMLInputElement {
  const el = [...container.querySelectorAll("input")].find((i) =>
    (i.placeholder ?? "").includes(placeholder),
  );
  if (!el) throw new Error(`找不到输入框：${placeholder}`);
  return el as HTMLInputElement;
}

/** 切到注册页并填表，只传需要覆盖的字段。同一用例内多次调用时先清掉上一次的 DOM */
function fillRegister(fields: {
  username?: string;
  password?: string;
  confirm?: string;
  email?: string;
  nickname?: string;
}): HTMLElement {
  cleanup();
  // 上一步可能已经注册成功并点亮了登录态（本文件故意验证「19 位放行」会真的提交），
  // 不重置的话下一次 render 直接进「当前已登录」分支，注册 tab 都找不到。
  resetAuth();
  const { container, getByText } = render(<LoginPage />);
  fireEvent.click(getByText("注册"));
  const set = (placeholder: string, value: string | undefined): void => {
    if (value === undefined) return;
    fireEvent.change(field(container, placeholder), { target: { value } });
  };
  // 「密码（」不会误命中「确认密码」（后者不含「（」），可以放心用片段
  set("用户名（", fields.username ?? "");
  set("昵称", fields.nickname ?? "");
  set("邮箱", fields.email ?? "");
  set("密码（", fields.password ?? "");
  set("确认密码", fields.confirm ?? "");
  return container;
}

/** 点按钮并等一拍（校验提示在异步 submit 里 setState） */
async function submit(container: HTMLElement, label: string): Promise<string> {
  fireEvent.click(
    Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === label,
    ) as HTMLButtonElement,
  );
  await new Promise((r) => setTimeout(r, 0));
  return container.textContent ?? "";
}

const VALID = {
  username: "listen01",
  password: "secret1",
  confirm: "secret1",
  email: "a@b.com",
};

describe("注册表单校验", () => {
  it("用户名按后端 3-30 校验：2 位拦下，19 位与含下划线放行", async () => {
    const short = fillRegister({ ...VALID, username: "ab" });
    expect(await submit(short, "注册并登录")).toContain("用户名需为 3-30 个字符");
    expect(invokeMock).not.toHaveBeenCalled();

    // 19 位：旧前端规则（5-18）会拦，后端 @Size(max=30) 允许 —— 锁住「不比后端更严」。
    // 断言「请求确实发出去了」而不是「没出现错误文案」：后者换了别的报错也会假通过。
    const long = fillRegister({ ...VALID, username: "listen0123456789012" });
    await submit(long, "注册并登录");
    expect(invokeMock).toHaveBeenCalledWith(
      "astral_register",
      expect.objectContaining({ username: "listen0123456789012" }),
    );

    // 含下划线：后端不限字符集，前端也不该拦
    invokeMock.mockClear();
    const underscore = fillRegister({ ...VALID, username: "listen_01" });
    await submit(underscore, "注册并登录");
    expect(invokeMock).toHaveBeenCalledWith(
      "astral_register",
      expect.objectContaining({ username: "listen_01" }),
    );
  });

  it("密码不在 6-18 位时给出提示", async () => {
    const c1 = fillRegister({ ...VALID, password: "12345", confirm: "12345" });
    expect(await submit(c1, "注册并登录")).toContain("密码需为 6-18 位");

    const tooLong = "a".repeat(19);
    const c2 = fillRegister({ ...VALID, password: tooLong, confirm: tooLong });
    expect(await submit(c2, "注册并登录")).toContain("密码需为 6-18 位");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("两次密码不一致时给出提示", async () => {
    const container = fillRegister({ ...VALID, confirm: "secret2" });
    expect(await submit(container, "注册并登录")).toContain("两次输入的密码不一致");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("邮箱必填且校验格式", async () => {
    const c1 = fillRegister({ ...VALID, email: "" });
    expect(await submit(c1, "注册并登录")).toContain("请填写邮箱");

    const c2 = fillRegister({ ...VALID, email: "not-an-email" });
    expect(await submit(c2, "注册并登录")).toContain("邮箱格式不正确");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("校验通过后调用注册接口，昵称随之上送", async () => {
    const container = fillRegister({ ...VALID, nickname: "轻听" });
    const text = await submit(container, "注册并登录");
    expect(text).not.toContain("格式");
    expect(invokeMock).toHaveBeenCalledWith(
      "astral_register",
      expect.objectContaining({
        username: "listen01",
        passwordConfirm: "secret1",
        email: "a@b.com",
        nickname: "轻听",
      }),
    );
    // 注册接口没有验证码字段（QtRegisterDto 无 code），界面上也不该出现
    expect(container.textContent).not.toContain("验证码");
  });
});

describe("登录表单校验", () => {
  it("账号接受邮箱（超过用户名上限也不拦），密码不套注册长度规则", async () => {
    const mail = "a-very-long-account-name@example.com"; // 34 字符 > USERNAME_MAX(30)
    const { container } = render(<LoginPage />);
    fireEvent.change(field(container, "用户名或邮箱"), { target: { value: mail } });
    fireEvent.change(field(container, "密码"), { target: { value: "pw" } });

    const text = await submit(container, "登 录");
    expect(text).not.toContain("用户名需为");
    expect(text).not.toContain("密码需为");
    expect(invokeMock).toHaveBeenCalledWith("astral_login", {
      username: mail,
      password: "pw",
    });
  });
});
