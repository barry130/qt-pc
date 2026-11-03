/**
 * 本地歌单封面的模块级缓存（pid → data URL；null = 确认没有自设封面）。
 *
 * 「我的歌单」列表页的封面图异步读文件（Rust 转成 data URL）后缓存在这里，
 * 避免每次重挂都去读一遍。歌单详情页换了 / 清了封面后**必须**先废掉对应项：
 * 缓存挂在模块级、跨页面存活，列表页组件重挂时 useState 初值直接吃旧值，
 * 不废掉的话列表页会一直显示旧封面。
 */
const cache = new Map<string, string | null>();

/** 读缓存项；undefined = 还没读过（该去读文件），null = 确认没有自设封面 */
export function cachedPlaylistCover(pid: string): string | null | undefined {
  return cache.get(pid);
}

/** 有没有读过（区分「没读过」与「读过、结果是没有」） */
export function hasCachedPlaylistCover(pid: string): boolean {
  return cache.has(pid);
}

export function setCachedPlaylistCover(pid: string, value: string | null): void {
  cache.set(pid, value);
}

/** 歌单封面换了/清了：废掉对应缓存（不传 pid = 全废）。 */
export function invalidatePlaylistCoverCache(pid?: string): void {
  if (pid === undefined) {
    cache.clear();
  } else {
    cache.delete(pid);
  }
}
