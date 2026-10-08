/**
 * 纵向滚动容器的查找（用户 m05249：滚动条拖不动 → 只能靠滚轮 → 滚轮又太慢）。
 *
 * 长列表的滚动容器散落在十几个页面里（`min-h-0 flex-1 overflow-y-auto` 那一层），
 * 逐个页面传 ref 要改十几处，这里统一从**事件目标**反推容器。
 */

/** 内容确实超高的纵向滚动容器（「回到顶部」用：没超出就不该出现按钮） */
export function isScrollableY(el: HTMLElement): boolean {
  const oy = getComputedStyle(el).overflowY;
  if (oy !== "auto" && oy !== "scroll") return false;
  return el.scrollHeight - el.clientHeight > 1;
}

/** 只按 overflow 判定，不看内容是否超出（滚轮加速用：滚到底了也不算"不可滚"） */
export function canScrollY(el: HTMLElement): boolean {
  const oy = getComputedStyle(el).overflowY;
  return oy === "auto" || oy === "scroll";
}

/**
 * 横向可滚且内容确实超宽 —— 命中就**不接管**这次滚轮。
 *
 * HorizontalScroller（首页卡片行）自己用原生 wheel 把纵向滚轮转成横向滚动，
 * 滚到两端才把事件交还页面。我们在内容区上的捕获监听比它早，若按"找纵向容器"
 * 的规则会直接把整页滚走，卡片行永远横滚不了。所以遍历时先遇到横向容器就让路。
 */
function deferToHorizontal(el: HTMLElement): boolean {
  const ox = getComputedStyle(el).overflowX;
  if (ox !== "auto" && ox !== "scroll") return false;
  return el.scrollWidth - el.clientWidth > 1;
}

/**
 * 从 el 起（含 el）向上到 root 止，取**最外层**可纵向滚动的元素。
 *
 * 「回到顶部」用最外层：滚的是内嵌小面板（歌词候选、下拉）时，要回的是整个
 * 页面列表的顶部，而不是那个小面板的顶部。
 */
export function outermostScrollable(
  el: Element | null,
  root: Element | null,
): HTMLElement | null {
  let found: HTMLElement | null = null;
  let cur: Element | null = el;
  while (cur !== null) {
    if (cur instanceof HTMLElement && isScrollableY(cur)) found = cur;
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return found;
}

/**
 * 滚轮加速用：取**最内层**纵向滚动容器；返回 null 表示这次不接管。
 *
 * 必须是"最内层"而不是"最外层"：嵌套滚动（弹层里的小列表套在页面长列表里）时
 * Chromium 的默认行为就是内层先吃，照搬这个顺序才不会"滚弹层却把整页滚飞"。
 * 这里**不看是否还能往该方向移动**（早期版本看，会导致滚到顶/底后事件穿透到
 * 外层把整页滚走）；内层是滚动容器就归它，到头了自然不动，语义与浏览器一致。
 */
export function pickWheelTarget(el: Element | null, root: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  while (cur !== null) {
    if (cur instanceof HTMLElement) {
      if (deferToHorizontal(cur)) return null; // 卡片行自己转横滚 → 让路
      if (canScrollY(cur)) return cur;
    }
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return null;
}
