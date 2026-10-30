import { useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { errMsg } from "@/lib/utils";
import { IconButton } from "./IconButton";
import { Popover } from "./Popover";

/**
 * 列表行内操作（本地曲库 / 下载管理共用）：定位文件 + 删除菜单。
 *
 * 删除分两档——只删记录（文件留着）、连磁盘文件一起删；后者不可恢复，
 * 菜单里要点第二下确认才真正执行。菜单开关、二次确认、忙碌态、错误上报都在
 * 组件内部，父级只提供「怎么删 / 怎么定位」的回调。
 */

function MenuItem(props: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className={`block w-full px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50 ${
        props.danger
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-secondary"
      }`}
    >
      {props.children}
    </button>
  );
}

export function RowActions(props: {
  /** 提供时显示「在文件夹中显示」按钮（没有落盘文件的下载任务不传） */
  onReveal?: () => Promise<void> | void;
  /** 执行删除；deleteFile = true 表示连磁盘文件一起删 */
  onDelete: (deleteFile: boolean) => Promise<void>;
  /** 失败提示（父级错误条展示） */
  onError: (msg: string) => void;
  /** 外部忙碌态（父级正在执行其它操作时禁用） */
  disabled?: boolean;
  /** 删除文件前的二次确认文案 */
  confirmLabel?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = props.disabled || busy;

  const reveal = async (): Promise<void> => {
    try {
      await props.onReveal?.();
    } catch (err) {
      props.onError(errMsg(err));
    }
  };

  const remove = async (deleteFile: boolean): Promise<void> => {
    setBusy(true);
    try {
      await props.onDelete(deleteFile);
      setOpen(false);
      setConfirming(false);
    } catch (err) {
      props.onError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // 收起（点外面 / Esc）顺手复位二次确认，避免下次打开还停在「确认删除」上
        if (!next) setConfirming(false);
      }}
      className="relative flex shrink-0 items-center"
      trigger={(t) => (
        <>
          {props.onReveal && (
            <button
              type="button"
              title="在文件夹中显示"
              aria-label="在文件夹中显示"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                void reveal();
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            title="删除"
            aria-label="删除"
            aria-haspopup="menu"
            aria-expanded={t.open}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              t.toggle();
              setConfirming(false);
            }}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    >
      {() => (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl border border-border bg-popover/95 p-1 backdrop-blur-xl shadow-raised"
        >
          <MenuItem disabled={busy} onClick={() => void remove(false)}>
            仅删除记录（保留文件）
          </MenuItem>
          {confirming ? (
            <MenuItem danger disabled={busy} onClick={() => void remove(true)}>
              {busy ? "删除中…" : (props.confirmLabel ?? "确认删除文件？不可恢复")}
            </MenuItem>
          ) : (
            <MenuItem danger onClick={() => setConfirming(true)}>
              删除文件和记录
            </MenuItem>
          )}
        </div>
      )}
    </Popover>
  );
}

/**
 * 批量删除（列表多选后用）：与行内删除同语义，作用于整批选中项。
 * 删除文件不可恢复，菜单里要点第二下「确认删除 N 首」才真正执行。
 */
export function BatchDeleteButton(props: {
  /** 选中数量（0 时禁用），也用于按钮文案与确认提示 */
  count: number;
  /** 执行批量删除；deleteFile = true 表示连磁盘文件一起删 */
  onDelete: (deleteFile: boolean) => Promise<void>;
  /** 删除成功回调（父级清空选择 / 刷新列表） */
  onDeleted: () => void;
  /** 失败提示（父级错误条展示） */
  onError: (msg: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = props.count;

  const remove = async (deleteFile: boolean): Promise<void> => {
    setBusy(true);
    try {
      await props.onDelete(deleteFile);
      setOpen(false);
      setConfirming(false);
      props.onDeleted();
    } catch (err) {
      props.onError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirming(false);
      }}
      trigger={(t) => (
        <IconButton
          label={count > 0 ? `批量删除（${count}）` : "批量删除"}
          variant="outline"
          size="md"
          hover="secondary"
          danger
          ariaHasPopup="menu"
          ariaExpanded={t.open}
          disabled={busy || count === 0}
          onClick={() => {
            t.toggle();
            setConfirming(false);
          }}
        >
          <Trash2 />
        </IconButton>
      )}
    >
      {() => (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 w-52 rounded-xl border border-border bg-popover/95 p-1 backdrop-blur-xl shadow-raised"
        >
          <MenuItem disabled={busy} onClick={() => void remove(false)}>
            仅删除记录（保留文件）
          </MenuItem>
          {confirming ? (
            <MenuItem danger disabled={busy} onClick={() => void remove(true)}>
              {busy ? "删除中…" : `确认删除 ${count} 首的文件？不可恢复`}
            </MenuItem>
          ) : (
            <MenuItem danger onClick={() => setConfirming(true)}>
              删除文件和记录
            </MenuItem>
          )}
        </div>
      )}
    </Popover>
  );
}
