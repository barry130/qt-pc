// @vitest-environment jsdom
// 注册表单本地校验：用户名 5-18 位英文/数字、密码至少 6 位、两次一致、
// 邮箱必填且格式正确。校验不过不发请求。
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

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

// vitest 未开 globals，RTL 不会自动清理；不清会把上一条用例的 DOM 一起查出来
afterEach(() => cleanup());

/** 切到注册页并填表，只传需要覆盖的字段。同一用例内多次调用时先清掉上一次的 DOM */
function fillRegister(fields: {
  username?: string;
  password?: string;
  confirm?: string;
  email?: string;
}): HTMLElement {
  cleanup();
  const { container, getByText, getByPlaceholderText } = render(<LoginPage />);
  fireEvent.click(getByText("注册"));
  const set = (placeholder: string, value: string): void => {
    if (value === undefined) return;
    fireEvent.change(getByPlaceholderText(placeholder), { target: { value } });
  };
  set("用户名（5-18 位英文或数字）", fields.username ?? "");
  set("密码（至少 6 位）", fields.password ?? "");
  set("确认密码", fields.confirm ?? "");
  set("邮箱", fields.email ?? "");
  return container;
}

async function submitAndTip(container: HTMLElement): Promise<string> {
  fireEvent.click(
    Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "注册并登录",
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
  it("用户名太短或含非法字符时给出提示", async () => {
    const c1 = fillRegister({ ...VALID, username: "ab1" });
    expect(await submitAndTip(c1)).toContain("用户名需为 5-18 位英文或数字");

    const c2 = fillRegister({ ...VALID, username: "listen_01" });
    expect(await submitAndTip(c2)).toContain("用户名需为 5-18 位英文或数字");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("密码不在 6-18 位时给出提示", async () => {
    const c1 = fillRegister({ ...VALID, password: "12345", confirm: "12345" });
    expect(await submitAndTip(c1)).toContain("密码需为 6-18 位");

    const tooLong = "a".repeat(19);
    const c2 = fillRegister({ ...VALID, password: tooLong, confirm: tooLong });
    expect(await submitAndTip(c2)).toContain("密码需为 6-18 位");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("两次密码不一致时给出提示", async () => {
    const container = fillRegister({ ...VALID, confirm: "secret2" });
    expect(await submitAndTip(container)).toContain("两次输入的密码不一致");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("邮箱必填且校验格式", async () => {
    const c1 = fillRegister({ ...VALID, email: "" });
    expect(await submitAndTip(c1)).toContain("请填写邮箱");

    const c2 = fillRegister({ ...VALID, email: "not-an-email" });
    expect(await submitAndTip(c2)).toContain("邮箱格式不正确");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("校验通过后调用注册接口，且不再发送验证码", async () => {
    const container = fillRegister(VALID);
    const text = await submitAndTip(container);
    expect(text).not.toContain("格式");
    expect(invokeMock).toHaveBeenCalledWith(
      "astral_register",
      expect.objectContaining({
        username: "listen01",
        passwordConfirm: "secret1",
        email: "a@b.com",
      }),
    );
    // 验证码字段与「发验证码」按钮已移除
    expect(container.textContent).not.toContain("发验证码");
    expect(container.textContent).not.toContain("验证码");
  });
});
