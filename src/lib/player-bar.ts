/**
 * 播放条按钮开关（设置 → 播放条）。
 *
 * 播放条上除「上一首 / 播放 / 下一首」以外的按钮都能由用户自行开关：设置页
 * 逐个列出，只有**打开**的按钮才渲染。剩下的按钮按**数量**自动分到播放键
 * 两侧——声明里靠前的那半放左边，剩下那半放右边，使播放键两侧条数尽量
 * 相等、中间的播放键保持大致居中。
 *
 * 存储：设置键 playerBar.visibleButtons 存**展示哪些**的 id 白名单（JSON）。
 * 旧键 playerBar.hiddenButtons（存被关掉的 id）作废：新口径下「默认只开
 * 收藏/播放模式/桌面歌词/下载/音质/音量」只能用白名单表达——黑名单表达
 * 不了一个「新增按钮默认关闭」的语义，用户升级进来会在旧值下看到不该
 * 默认出现的新按钮。白名单里的未知 id / 重复 id 一律清洗掉。
 *
 * 名额：除音量（slot:"end"，固定在播放条最右侧）以外最多同时展示
 * PLAYER_BAR_MAX_VISIBLE 个（用户要求「除了音量外最多展示10个」）。
 */
export interface PlayerBarButtonMeta {
  id: string;
  label: string;
  hint: string;
  /** 仅 qt_admin 可见（播放链接调试入口） */
  adminOnly: boolean;
  /** inline = 参与左右分列的按钮；end = 固定在播放条最右侧（音量滑块） */
  slot: "inline" | "end";
}

/** 声明顺序 = 设置页展示顺序 = 左右分列的先后顺序 */
export const PLAYER_BAR_BUTTONS: PlayerBarButtonMeta[] = [
  {
    id: "playUrl",
    label: "播放链接",
    hint: "内部账号专用：查看当前歌曲的实际播放地址与取链线路",
    adminOnly: true,
    slot: "inline",
  },
  {
    id: "speed",
    label: "播放倍速",
    hint: "倍速菜单（立即生效并记忆，所有歌曲通用）",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "sleep",
    label: "睡眠定时",
    hint: "定时停止播放（到点或播完当前曲目后停）",
    adminOnly: false,
    slot: "inline",
  },
  { id: "collect", label: "收藏", hint: "收藏到本地歌单", adminOnly: false, slot: "inline" },
  {
    id: "dislike",
    label: "不喜欢",
    hint: "屏蔽当前歌曲 / 歌手（不再推荐）",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "mode",
    label: "播放模式",
    hint: "顺序 / 列表循环 / 单曲循环 / 随机",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "desktopLyric",
    label: "桌面歌词",
    hint: "桌面歌词窗口开关",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "queue",
    label: "播放队列",
    hint: "展开 / 收起播放队列面板",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "download",
    label: "下载",
    hint: "下载当前歌曲（有曲目时才出现）",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "quality",
    label: "音质",
    hint: "切换当前歌曲音质（本地音乐不显示）",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "artist",
    label: "歌手",
    hint: "打开当前歌曲的歌手页（按歌手名搜作品）",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "spectrum",
    label: "频谱",
    hint: "播放页频谱背景开关",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "equalizer",
    label: "均衡器",
    hint: "打开均衡器 / 音效设置面板",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "share",
    label: "分享",
    hint: "复制歌曲信息（歌名 / 歌手 / 链接）",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "source",
    label: "换源",
    hint: "当前源不支持时，搜索其他音源的这首歌并切换",
    adminOnly: false,
    slot: "inline",
  },
  {
    id: "volume",
    label: "音量",
    hint: "播放条最右侧的音量滑块",
    adminOnly: false,
    slot: "end",
  },
];

/** 除音量外最多展示多少个 inline 按钮（用户要求「除了音量外最多展示10个」） */
export const PLAYER_BAR_MAX_VISIBLE = 10;

/** 首次运行（设置里没有这个键）时的默认展示集：收藏/播放模式/桌面歌词/下载/音质/音量 */
export const PLAYER_BAR_DEFAULT_VISIBLE: string[] = [
  "collect",
  "mode",
  "desktopLyric",
  "download",
  "quality",
  "volume",
];

export function playerBarButtonMeta(id: string): PlayerBarButtonMeta | null {
  for (const meta of PLAYER_BAR_BUTTONS) {
    if (meta.id === id) return meta;
  }
  return null;
}

/** 某按钮是否占 inline 名额（slot:"end" 的音量不占） */
export function playerBarCounts(id: string): boolean {
  return playerBarButtonMeta(id)?.slot === "inline";
}

/** 已展示的 inline 按钮数量（音量不计入） */
export function countPlayerBarVisible(visible: string[]): number {
  let n = 0;
  for (const id of visible) {
    if (playerBarCounts(id)) n++;
  }
  return n;
}

/** 解析设置值：非字符串 / 非法 JSON / 非数组一律按默认集处理 */
export function parseVisibleButtons(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return PLAYER_BAR_DEFAULT_VISIBLE.slice();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return PLAYER_BAR_DEFAULT_VISIBLE.slice();
  }
  if (!Array.isArray(parsed)) return PLAYER_BAR_DEFAULT_VISIBLE.slice();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string" || playerBarButtonMeta(item) === null || out.includes(item)) {
      continue;
    }
    if (playerBarCounts(item) && countPlayerBarVisible(out) >= PLAYER_BAR_MAX_VISIBLE) {
      continue;
    }
    out.push(item);
  }
  return out;
}

export function serializeVisibleButtons(visible: string[]): string {
  return JSON.stringify(visible.filter((id) => playerBarButtonMeta(id) !== null));
}

/**
 * 左右分列：把 inline 按钮按声明顺序分成两组，左组取 ⌈n/2⌉ 个，
 * 保证两侧条数差不超过 1（播放键居中）。
 */
export function splitPlayerBarButtons(visibleIds: string[]): {
  left: string[];
  right: string[];
} {
  const inline = visibleIds.filter((id) => playerBarButtonMeta(id)?.slot === "inline");
  const target = Math.ceil(inline.length / 2);
  return {
    left: inline.slice(0, target),
    right: inline.slice(target),
  };
}
