import type { Track } from "@/types";

/**
 * 同一首歌的「跨源键」（搜索页跨页去重用）。
 *
 * 为什么只剩这一个函数：2026-10-24 起「聚合搜索怎么合并/去重/排序」全部住数据包
 * （`searchMerged` / `searchMany`，DESIGN §1.2），宿主不再保留 app 侧合并实现 ——
 * 两处各写一份规则必然漂移（包修了判重，app 还是旧的）。搜索页只需要一个稳定的
 * 「这两条是不是同一首歌」判断来给跨页结果去重，所以留下 `songKey`，其余（打分、
 * 版本挑选、排序）随 `lib/aggregate-merge.ts` 一起删除。
 *
 * 纯函数：不读时间、不随机、不缓存。归一化口径必须与数据包
 * `qt-sources/src/actions/merge-search.ts` 的判重键一致，改规则要两边一起看。
 */

// ---------- 归一化 ----------

/**
 * 成对括号的定界符。中日文歌名里这四种都会出现，且常混用
 * （`晴天（Live）`、`晴天 [Live]`、`晴天【Live】`）。
 */
const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["（", "）"],
  ["(", ")"],
  ["[", "]"],
  ["【", "】"],
];

/**
 * 括号段里装的是**版本信息**而不是歌名本体：`晴天 (Live)`、`告白气球（片段）`、
 * `稻香 (伴奏)`。归一化时整段丢掉，这几条才会和 `晴天` / `告白气球` / `稻香` 撞成同一个键。
 *
 * 用「深度扫描」而不是 `[（(][^）)]*[）)]` 这样的正则，因为括号会**嵌套**：
 * `晴天（Live（现场版））` 用正则只能吃掉内层，留下 `晴天（Live）` 这种半截。
 * 深度扫描天然支持任意层嵌套；括号不闭合时（源站数据脏）一路丢到结尾，
 * 总比留下半个括号段更接近歌名本体。
 */
function stripBracketSegments(text: string): string {
  let out = "";
  let depth = 0;
  // 用一个栈记住「当前层期待哪个闭合符」，混用括号时不会提前收尾
  const closers: string[] = [];
  for (const ch of text) {
    if (depth === 0) {
      const pair = BRACKET_PAIRS.find(([open]) => open === ch);
      if (pair) {
        closers.push(pair[1]);
        depth += 1;
        continue;
      }
      out += ch;
      continue;
    }
    // 括号内部：只关心嵌套开括号与对应闭合符，其余一律丢弃
    if (ch === closers[closers.length - 1]) {
      closers.pop();
      depth -= 1;
      continue;
    }
    const nested = BRACKET_PAIRS.find(([open]) => open === ch);
    if (nested) {
      closers.push(nested[1]);
      depth += 1;
    }
  }
  return out;
}

/**
 * 归一化（去空白、去括号段、去标点、小写）。
 *
 * 与 `daily-recommend.ts` 的 `normText` 同口径但**独立实现**：那个模块会被集成层
 * 整体替换，map 键也不能跨模块复用；口径一旦分叉，代价是「同一首歌在推荐页能合并、
 * 在搜索页不能合并」，所以两边的规则要一起改。
 */
export function normText(text?: string | null): string {
  return (
    stripBracketSegments(String(text ?? ""))
      // 全角空格 U+3000 不是 \s 的一员（旧实现单独列了它），统一当空白处理
      .replace(/[\s\u3000]+/g, "")
      // 标点：中文顿号/间隔号、中英逗号句号、连接符、引号、感叹问号冒号分号都去掉。
      // 歌名里的这些符号各平台写法不一致（`Don't Stop` vs `Dont Stop`），留着就合并不上。
      // 书名号/引号类也去掉：源站常返回 `《晴天》`，用户搜「晴天」时它得和 `晴天` 撞成同一个键
      .replace(/[·・.,，、\-—_/\\'"“”‘’!！?？:：;；~～()（）[\]【】《》〈〉「」『』]/g, "")
      .toLowerCase()
  );
}

/**
 * 歌手串拆成单个歌手名。
 * 各平台分隔符五花八门：`蔡依林/周杰伦`、`周杰伦、温岚`、`A & B`、`A feat. B`，
 * 甚至直接用空格。先把这些统一成「拆开」再各自归一化。
 */
function splitSingers(singer?: string | null): string[] {
  return String(singer ?? "")
    .split(/[、,，/&＆;；|]+|[\s\u3000]+/)
    .map((part) => normText(part))
    .filter((part) => part.length > 0);
}

/**
 * 同一首歌的键：`归一化标题|排序后的歌手集合`。
 *
 * 歌手**排序**是关键：`蔡依林/周杰伦` 和 `周杰伦/蔡依林` 是同一首歌的两个合唱版本，
 * 各平台排列顺序不一样，不排序就永远合并不上。排序用默认字典序即可 —— 只要稳定就行，
 * 不需要人类可读。
 *
 * 标题为空时退回 `platform:id`：源站偶尔返回无标题的脏数据，如果都归一到空标题，
 * 这些**互不相关**的曲目会被并成一条，等于凭空删歌。
 */
export function songKey(track: Track): string {
  const title = normText(track.title);
  if (title === "") return `${track.platform}:${track.id}`;
  const singers = splitSingers(track.singer).sort().join("/");
  return `${title}|${singers}`;
}
