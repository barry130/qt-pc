/**
 * 词条分片（B6 第二轮续 / R84+）。
 *
 * 为什么拆文件：设置页有 13 个分节、六百多条文案，全塞进 `lib/i18n.ts` 会变成
 * 一个谁都懒得多看一眼的巨型文件，也会让「几个人同时翻不同分节」变成改同一个文件的冲突。
 * 所以每个分节自己一个分片文件（`lib/i18n/settings-*.ts`），`lib/i18n.ts` 只负责合并。
 *
 * 类型约束：`zh` 定义了键，`en` 必须一一对齐（少一条 `tsc` 就报错），
 * 这样「英文漏翻」不会靠人眼发现。
 */

export type Fragment<Z extends Record<string, string>> = {
  zh: Z;
  en: { [K in keyof Z]: string };
};

/** 只是给分片一个统一的定义入口（带类型推导），不做额外处理 */
export function defineFragment<Z extends Record<string, string>>(fragment: Fragment<Z>): Fragment<Z> {
  return fragment;
}
