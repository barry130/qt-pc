/**
 * 「仅首次登录弹出」的已弹标记：按公告 ID 各记一条。
 *
 * 历史实现是一个全局布尔（`quietmusic.notice.first-login = "shown"`），于是用户关掉
 * 任意一条「仅首次登录」公告后，后台再发布新的一条也永远不会弹——这不符合运营预期。
 * 现在改为「一条公告一个键」：老键在升级后一次性迁移成「把当前已下发的这些公告都
 * 记为已弹」，老用户不会重复看到旧公告，新发布的公告仍能正常弹一次。
 */

export const LEGACY_FIRST_LOGIN_KEY = "quietmusic.notice.first-login";
export const FIRST_LOGIN_KEY_PREFIX = "quietmusic.notice.first-login-";

export type NoticeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function firstLoginKey(noticeId: number): string {
  return `${FIRST_LOGIN_KEY_PREFIX}${noticeId}`;
}

/** 这条公告是否已经弹过（按 id 记） */
export function readFirstLoginShown(noticeId: number, store: NoticeStorage = localStorage): boolean {
  try {
    return store.getItem(firstLoginKey(noticeId)) === "shown";
  } catch {
    return false;
  }
}

export function markFirstLoginShown(noticeId: number, store: NoticeStorage = localStorage): void {
  try {
    store.setItem(firstLoginKey(noticeId), "shown");
  } catch {
    // 写不进只会让这条公告下次再弹一次，不影响功能
  }
}

/**
 * 老全局标记的一次性迁移：把当前已下发的这些「仅首次登录」公告全部记为已弹，
 * 再删掉老键。返回是否真的执行了迁移。
 *
 * 之所以是「全部标为已弹」而不是猜测：老标记只能说明「用户关过某一条」，
 * 无从知道是哪一条；全部标掉能保证升级后不重复打扰，新公告不受影响。
 */
export function migrateLegacyFirstLogin(
  noticeIds: readonly number[],
  store: NoticeStorage = localStorage,
): boolean {
  try {
    if (store.getItem(LEGACY_FIRST_LOGIN_KEY) !== "shown") return false;
    if (noticeIds.some((id) => store.getItem(firstLoginKey(id)) === "shown")) return false;
    for (const id of noticeIds) store.setItem(firstLoginKey(id), "shown");
    store.removeItem(LEGACY_FIRST_LOGIN_KEY);
    return true;
  } catch {
    return false;
  }
}
