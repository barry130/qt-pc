import { useMemo } from "react";

/**
 * 回答正文渲染。
 *
 * 后端返回的是纯文本（模型按 JSON Schema 输出 `answer` 字段，里面是自然语言），
 * 工程里没有 markdown 依赖，也不该为一句话答案引一个进来。所以这里只做三件
 * 便宜但明显提升可读性的事：
 *
 * - 空行分段（模型习惯用空行断段，直接 `white-space: pre-wrap` 会连成一片）
 * - `- ` / `* ` / `1. ` 开头的行聚成列表
 * - `**粗体**` 与 `` `代码` `` 行内强调（模型最常用的两种标记）
 *
 * 不做 HTML：正文来自模型，任何情况下都不经过 `dangerouslySetInnerHTML`。
 */

type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

const BULLET = /^[-*·]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

function parse(content: string): Block[] {
  const blocks: Block[] = [];
  const paragraphs = content.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    const ul: string[] = [];
    const ol: string[] = [];
    const plain: string[] = [];
    for (const line of lines) {
      const bullet = BULLET.exec(line.trim());
      if (bullet !== null) {
        ul.push(bullet[1]);
        continue;
      }
      const numbered = NUMBERED.exec(line.trim());
      if (numbered !== null) {
        ol.push(numbered[1]);
        continue;
      }
      plain.push(line);
    }
    if (plain.length > 0) blocks.push({ kind: "p", text: plain.join("\n") });
    if (ul.length > 0) blocks.push({ kind: "ul", items: ul });
    if (ol.length > 0) blocks.push({ kind: "ol", items: ol });
  }
  return blocks;
}

/** 行内强调：`**粗**` 与 `` `代码` ``，其余原样 */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  let index = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(
        <code key={key} className="rounded bg-secondary px-1 py-0.5 text-[0.92em]">
          {token.slice(1, -1)}
        </code>,
      );
    }
    cursor = match.index + token.length;
    index += 1;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export function AnswerText(props: { content: string }): React.JSX.Element {
  const blocks = useMemo(() => parse(props.content), [props.content]);
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed">
      {blocks.map((block, i) => {
        if (block.kind === "ul") {
          return (
            <ul key={i} className="ml-4 flex list-disc flex-col gap-1">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item, `u${i}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "ol") {
          return (
            <ol key={i} className="ml-4 flex list-decimal flex-col gap-1">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item, `o${i}-${j}`)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            {inline(block.text, `p${i}`)}
          </p>
        );
      })}
    </div>
  );
}
