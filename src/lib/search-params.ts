/**
 * 搜索页的 URL 查询参数（DESIGN §5.2 `/search?q=&type=`）。
 *
 * 为什么页签必须进 URL、而不是留在 SearchPage 的 useState 里：
 * 搜索页**不在 KeepAliveOutlet 的常驻名单**（它依赖 q，缓存会串味，见
 * KeepAliveOutlet 头注）。从 /search 点进歌单 / 歌手 / 专辑详情再点返回时，
 * SearchPage 是**重新挂载**的 —— 页签留在组件 state 里就会被初始化成默认的
 * 「歌曲」：用户明明是从「歌单」点进去的，返回却看到同一个词条的歌曲列表。
 * 放进 URL 后返回 / 前进都能复现同一个视图，也和 DESIGN 的路由表一致。
 *
 * 聚合开关（DESIGN 里的 `scope=current|all`）仍然放在 stores/musicSource 里
 * 持久化：它是跨会话记住的偏好，本来就随全局 store 存活，不随页面重挂载丢失。
 */
export const SEARCH_TYPES = ["song", "playlist", "artist", "album"] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/** URL 里的 type 不可信（用户可手改、旧书签可能没有）⇒ 收敛到合法值，缺省「歌曲」 */
export function parseSearchType(value: unknown): SearchType {
  return SEARCH_TYPES.includes(value as SearchType) ? (value as SearchType) : "song";
}