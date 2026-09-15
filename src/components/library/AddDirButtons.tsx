import { useState } from "react";
import { ChevronDown, FolderPlus, HardDrive } from "lucide-react";
import { errMsg } from "@/lib/utils";
import * as ipc from "@/services/ipc";

/**
 * 本地曲库的两个添加入口：「添加文件夹」（系统原生目录选择器）与
 * 「扫描整个磁盘」（枚举盘符根目录）。选中的路径交给父组件处理，
 * 本地音乐页 / 音乐文件夹页共用，避免两处重复实现。
 */
export function AddDirButtons(props: {
  /** path 为选中的文件夹或盘符根；wholeDrive 表示是否来自「整个磁盘」 */
  onPick: (path: string, wholeDrive: boolean) => void | Promise<void>;
  disabled?: boolean;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const chooseFolder = async (): Promise<void> => {
    setError(null);
    try {
      const picked = await ipc.pickFolder();
      if (picked) await props.onPick(picked, false);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const toggleDrives = async (): Promise<void> => {
    setError(null);
    try {
      const list = await ipc.listDrives();
      setDrives(Array.isArray(list) ? list : []);
      setMenuOpen((v) => !v);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const pickDrive = (drive: string): void => {
    setMenuOpen(false);
    void props.onPick(drive, true);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void chooseFolder()}
        disabled={props.disabled}
        className="flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
      >
        <FolderPlus className="h-3.5 w-3.5" />
        添加文件夹
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => void toggleDrives()}
          disabled={props.disabled}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
        >
          <HardDrive className="h-3.5 w-3.5" />
          扫描整个磁盘
          <ChevronDown className="h-3 w-3" />
        </button>
        {menuOpen && (
          <ul
            role="menu"
            className="absolute left-0 top-full z-20 mt-1 min-w-[7rem] rounded-md border border-border bg-background py-1 shadow-md"
          >
            {drives.length === 0 ? (
              <li className="px-3 py-1.5 text-xs text-muted-foreground">
                未找到磁盘
              </li>
            ) : (
              drives.map((d) => (
                <li key={d}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => pickDrive(d)}
                    className="w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-secondary"
                  >
                    {d}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
