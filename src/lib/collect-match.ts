/**
 * 收藏版本候选的相似度规则。与 qt-uniappx/services/collect-match.ts 保持相同，
 * check:source-collection 会检查两端文件与结果。只提示用户选择，不自动删歌。
 */
export const COLLECT_MATCH_THRESHOLDS = {
  title: 85,
  singer: 80,
  albumTitle: 75,
  albumSinger: 70,
  album: 70,
};

export type CollectMatchKey = { title: string; singers: string[]; album: string };
export type CollectSimilarity = {
  title: number;
  singer: number | null;
  album: number | null;
  matches: boolean;
};

// feat/ft 必须是独立词，不能拆开 Taylor Swift 等名字。
const ARTIST_SEPARATORS = /[/／\\|&、,，;；+＋]|和|与|\s+(?:featuring|feat\.?|ft\.?)\s+/gi;
const PUNCTUATION = /[()（）[\]【】{}<>《》「」『』"'“”‘’.,，。、:：;；!！?？~～_\-—…·|/\\]/g;
// 版本和影视说明只影响展示，不影响同曲候选；原始歌名完整保留在选择列表中。
const TITLE_NOTES = /[（([【][^)）\]】]*(?:live|remix|instrumental|acoustic|cover|demo|ost|mv|dj|remaster|伴奏|翻唱|纯音乐|清唱|现场|原声|主题曲|片头曲|片尾曲|插曲|版)[^)）\]】]*[)）\]】]/gi;

function foldText(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    result += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : text.charAt(i);
  }
  return result.toLowerCase();
}

function compactName(text: string): string {
  return text.replace(/\s+/g, "").replace(PUNCTUATION, "");
}

function normalizeTitle(text: string): string {
  return compactName(foldText(text).replace(TITLE_NOTES, ""));
}

/** 待收藏的元数据只归一化一次，供整张歌单复用。 */
export function prepareCollectMatch(title: string, singer: string, album: string): CollectMatchKey {
  const singers: string[] = [];
  // 括号内的外文别名也可独立匹配（周杰伦 / Jay Chou）。
  const parts = foldText(singer ?? "").replace(/[()（）[\]【】]/g, ",").split(ARTIST_SEPARATORS);
  for (const part of parts) {
    const name = compactName(part);
    if (name.length > 0 && !singers.includes(name)) singers.push(name);
  }
  return { title: normalizeTitle(title ?? ""), singers, album: normalizeTitle(album ?? "") };
}

/** 编辑距离百分比；缺失文本不算相同，短名称仅接受规范化后的精确匹配。 */
function nameSimilarity(a: string, b: string, protectShort: boolean): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 100;
  if (protectShort && Math.min(a.length, b.length) <= 3) return 0;
  // 异常长的元数据只接受精确匹配，避免整张歌单查重时进行无界平方计算。
  const length = Math.max(a.length, b.length);
  if (length > 256) return 0;
  const row: number[] = [];
  for (let j = 0; j <= b.length; j++) row.push(j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      diagonal = above;
    }
  }
  return (length - row[b.length]) * 100 / length;
}

export function compareCollectMatch(a: CollectMatchKey, b: CollectMatchKey): CollectSimilarity {
  const title = nameSimilarity(a.title, b.title, true);
  const album = a.album.length > 0 && b.album.length > 0 ? nameSimilarity(a.album, b.album, false) : null;
  let singer: number | null = null;
  if (a.singers.length > 0 && b.singers.length > 0) {
    singer = 0;
    for (const x of a.singers) {
      for (const y of b.singers) singer = Math.max(singer, nameSimilarity(x, y, true));
    }
  }
  let matches: boolean;
  if (singer === null) {
    // 缺一侧歌手时需专辑佐证；两侧都缺失延续精确同名的兼容，但不同专辑不误并。
    const bothMissing = a.singers.length === 0 && b.singers.length === 0;
    matches = title === 100 && (album !== null ? album >= COLLECT_MATCH_THRESHOLDS.album : bothMissing);
  } else {
    matches = (title >= COLLECT_MATCH_THRESHOLDS.title && singer >= COLLECT_MATCH_THRESHOLDS.singer)
      || (title >= COLLECT_MATCH_THRESHOLDS.albumTitle && singer >= COLLECT_MATCH_THRESHOLDS.albumSinger
        && album !== null && album >= COLLECT_MATCH_THRESHOLDS.album);
  }
  return { title, singer, album, matches };
}
