// @vitest-environment jsdom
/**
 * 共享 UI 原语（`src/components/ui/*`）的契约。
 *
 * 守的是「页面能不能放心复用」：
 * 1. `Button` 是唯一按钮外观来源——默认 `type="button"`（不会误触发表单提交）、`loading` 自动禁用并转圈；
 * 2. `Modal` 的焦点/关闭语义：Esc、点遮罩、×、`dismissible={false}`、`closeOnBackdrop={false}`；
 * 3. `Field` / `Switch` / `Segmented` 的可访问性标记（id 关联、role/aria-checked）；
 * 4. `Spinner` / `Badge` / `FormRow` 的基本输出。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  Badge,
  Button,
  buttonClass,
  ConfirmDialog,
  Field,
  FormRow,
  Input,
  Modal,
  Segmented,
  Spinner,
  Switch,
} from "@/components/ui";

describe("Button", () => {
  it("默认 type=button，不会误提交表单", () => {
    render(<Button>保存</Button>);
    expect(screen.getByRole("button", { name: "保存" }).getAttribute("type")).toBe("button");
  });

  it("loading 时自动禁用并渲染转圈", () => {
    render(<Button loading>保存</Button>);
    const button = screen.getByRole("button", { name: /保存/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.querySelector("[role='status']")).toBeTruthy();
  });

  it("variant 走 cva：primary 与 outline 类名不同", () => {
    const { rerender } = render(<Button variant="primary">确定</Button>);
    const primary = screen.getByRole("button", { name: "确定" }).className;
    rerender(<Button variant="outline">确定</Button>);
    const outline = screen.getByRole("button", { name: "确定" }).className;
    expect(primary).not.toBe(outline);
    expect(outline).toContain("border-border");
  });

  it("buttonClass 给链接元素套同一套外观", () => {
    expect(buttonClass({ variant: "outline" })).toContain("border-border");
    expect(buttonClass({ variant: "primary" })).toContain("bg-primary");
  });
});

describe("Spinner / Badge", () => {
  it("Spinner 带读屏文案", () => {
    render(<Spinner label="正在加载列表" />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("正在加载列表");
  });

  it("Badge 按 tone 着色", () => {
    render(<Badge tone="danger">已过期</Badge>);
    expect(screen.getByText("已过期").className).toContain("destructive");
  });
});

describe("表单原语", () => {
  it("Field 自动把 label 关联到子控件", () => {
    render(
      <Field label="歌单名" hint="最多 40 字">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("歌单名");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain("最多 40 字");
  });

  it("有错误时控件标记 aria-invalid", () => {
    render(
      <Field label="搜索" error="不能为空">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText("搜索").getAttribute("aria-invalid")).toBe("true");
  });

  it("Switch 是 role=switch 且点击回调最新值", () => {
    const onToggle = vi.fn();
    render(<Switch checked={false} onToggle={onToggle} label="桌面歌词" />);
    const button = screen.getByRole("switch", { name: "桌面歌词" });
    expect(button.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("Segmented 是 radiogroup，点选项回传值", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="排序"
        value="count"
        onChange={onChange}
        options={[
          { value: "count", label: "次数" },
          { value: "duration", label: "时长" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "排序" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "时长" }));
    expect(onChange).toHaveBeenCalledWith("duration");
  });

  it("FormRow 渲染标题与说明", () => {
    render(
      <FormRow title="开机自启" description="登录后自动启动">
        <Switch checked onToggle={() => {}} label="开机自启" />
      </FormRow>,
    );
    expect(screen.getByText("开机自启")).toBeTruthy();
    expect(screen.getByText("登录后自动启动")).toBeTruthy();
  });
});

describe("Modal", () => {
  it("Esc 关闭（焦点在弹层里也能关）", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="确认">
        内容
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole("dialog", { name: "确认" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩关闭，点内容不关", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="确认">
        <p>内容</p>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByText("内容"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismissible=false 时 Esc 与 × 都失效", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="请阅读公告" dismissible={false}>
        内容
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByLabelText("关闭")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closeOnBackdrop=false 时点遮罩不关", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="确认" closeOnBackdrop={false}>
        内容
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closeLabel 定制读屏文案，点 × 关闭", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="AI 供应商" closeLabel="关闭 AI 供应商设置">
        内容
      </Modal>,
    );
    fireEvent.click(screen.getByLabelText("关闭 AI 供应商设置"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("open=false 不渲染", () => {
    render(
      <Modal open={false} onClose={() => {}} title="确认">
        内容
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  it("确认/取消各自回调，danger 走危险色", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="删除歌单"
        description="不可恢复"
        tone="danger"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("busy 时确认按钮禁用", () => {
    render(
      <ConfirmDialog open busy title="删除中" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /确定/ }).hasAttribute("disabled")).toBe(true);
  });
});
