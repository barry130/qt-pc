/**
 * 键盘事件的「输入法合成」判定。
 *
 * WebView2/Chromium 在中文、日文输入法选字上屏时，仍然会派发 `key === "Enter"`
 * （此时 `isComposing` 为 true；Safari 与部分 Chromium 版本还会给 `keyCode === 229`）。
 * 任何把回车当「确认/执行」的地方都必须先问一句，否则用户拼音打到一半按回车选字，
 * 会直接把还没上屏的拼音当成关键词搜出去，或者执行当前高亮的命令
 * （评审 2026-10-29：命令面板、搜索页、歌词搜索三处都踩了这个坑）。
 */
export function isComposingEnter(event: {
  nativeEvent?: { isComposing?: boolean };
  keyCode?: number;
}): boolean {
  if (event.nativeEvent?.isComposing === true) return true;
  return event.keyCode === 229;
}
