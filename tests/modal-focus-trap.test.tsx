// @vitest-environment jsdom
/**
 * C09 模态弹层焦点陷阱回归。
 *
 * 旧实现只把打开前的焦点记下来、从不主动送进弹层，Tab 监听也只挂在 dialog 上；
 * 更麻烦的是 `onClose` 常是内联箭头函数，一放进 effect 依赖，父组件每次重渲染都会
 * 先跑 cleanup 把焦点还回弹层外 ——「焦点陷阱」等于断开。
 *
 * 这里锁定四条用户可见行为：
 * 1. 打开后焦点主动进入弹层（子元素 autofocus 时保留子元素）；
 * 2. 父组件用新的内联 onClose 重渲染，焦点不被踢出去；
 * 3. Tab / Shift+Tab 从容器或控件边缘都只在弹层内循环，焦点跑到外面也会被拉回来；
 * 4. 关闭后焦点回到打开它的按钮，Esc 在焦点位于弹层外时同样能关。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";

import { Modal } from "@/components/ui/modal";

afterEach(() => {
  cleanup();
});

function Harness(props: {
  onClose: () => void;
  withAutoFocus?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Modal
        open={open}
        title="测试弹层"
        onClose={() => {
          props.onClose();
          setOpen(false);
        }}
        footer={
          <>
            <button type="button">取消</button>
            <button type="button">确认</button>
          </>
        }
      >
        {props.withAutoFocus ? <input aria-label="名称" autoFocus /> : <p>内容</p>}
      </Modal>
    </div>
  );
}

function openModal(): HTMLElement {
  const opener = screen.getByRole("button", { name: "打开" });
  opener.focus();
  fireEvent.click(opener);
  return screen.getByRole("dialog", { name: "测试弹层" });
}

describe("useFocusTrap / Modal 焦点管理", () => {
  it("打开时焦点主动进入弹层容器（不落在确认按钮上）", () => {
    render(<Harness onClose={() => undefined} />);
    const dialog = openModal();
    expect(document.activeElement).toBe(dialog);
    // ConfirmDialog 的语义：不能一打开就停在确认按钮上（手快的回车会误删）
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "确认" }));
  });

  it("子元素 autofocus 优先于容器", () => {
    render(<Harness onClose={() => undefined} withAutoFocus />);
    openModal();
    expect(document.activeElement).toBe(screen.getByLabelText("名称"));
  });

  it("父组件换新的内联 onClose 重渲染，焦点不被踢回弹层外", () => {
    const { rerender } = render(<Harness onClose={() => undefined} />);
    const dialog = openModal();
    const cancel = screen.getByRole("button", { name: "取消" });
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    // 新的内联 onClose（每次渲染都是新引用）+ 内容变化
    rerender(<Harness onClose={() => undefined} withAutoFocus={false} />);

    expect(screen.getByRole("dialog", { name: "测试弹层" })).toBe(dialog);
    expect(document.activeElement).toBe(cancel);
  });

  it("Tab / Shift+Tab 从容器进入边缘控件并循环", () => {
    render(<Harness onClose={() => undefined} />);
    const dialog = openModal();
    const close = screen.getByLabelText("关闭");
    const confirm = screen.getByRole("button", { name: "确认" });

    // 容器 → 第一个控件
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // 容器 → Shift+Tab → 最后一个控件
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    // 最后一个控件 → Tab → 回到第一个
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // 第一个控件 → Shift+Tab → 回到最后一个
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("焦点被移到弹层外时，Tab 会被拉回弹层第一个控件", () => {
    render(<Harness onClose={() => undefined} />);
    openModal();
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("关闭"));
  });

  it("关闭后焦点回到打开它的按钮", () => {
    render(<Harness onClose={() => undefined} />);
    const dialog = openModal();
    const opener = screen.getByRole("button", { name: "打开" });

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("焦点不在弹层里时 Esc 仍然能关闭", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openModal();
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
