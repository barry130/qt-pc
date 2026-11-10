import type { CSSProperties, ReactNode } from "react";
import * as ipc from "@/services/ipc";

/**
 * 富文本（HTML 片段）渲染（消息中心正文用）。
 *
 * 后端公告正文允许携带 HTML（`SysNotice.content` 注释为「可承载富文本」，移动端也按
 * HTML 解析）。这里刻意**不用** `dangerouslySetInnerHTML`：先把 HTML 解析成节点树，
 * 再用 React 元素渲染。React 天然转义文本，配合标签 / 属性白名单（脚本、事件属性、
 * 非 http(s) 链接一律丢弃），注入面为零。
 *
 * 同时兼容纯文本正文：整段不含标签时按纯文本渲染（保留换行 + 链接可点）。
 */

interface ElementNode {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
interface TextNode {
  text: string;
}
type Node = ElementNode | TextNode;

/** 空标签（无闭合） */
const VOID_TAGS = new Set(["br", "hr", "img"]);
/** 换行时补一个空行的块级标签（纯文本摘要用） */
const BLOCK_BREAK_TAGS = new Set([
  "p", "div", "section", "article", "figure", "figcaption", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
  "pre", "table", "tr",
]);

/** 是否像 HTML（有 `<tag` 形态）；纯文本里的 `1 < 2` 不会误判 */
export function looksLikeHtml(html: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(html);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** 预清洗：注释、script/style 等整段剔除（否则其内容会当正文显示出来） */
function stripDangerous(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|noscript)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|noscript)\b[^>]*>/gi, "");
}

/** HTML → 节点树。未闭合标签容错，未知标签保留（渲染时当容器展开） */
export function parseHtml(html: string): Node[] {
  const root: Node[] = [];
  const stack: ElementNode[] = [];
  const tokenRe = /<[^>]+>|[^<]+/g;
  const closeRe = /^<\s*\/\s*([a-zA-Z][\w-]*)/;
  const openRe = /^<\s*([a-zA-Z][\w-]*)([\s\S]*?)\/?>$/;

  const append = (node: Node): void => {
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) parent.children.push(node);
    else root.push(node);
  };
  const inPre = (): boolean =>
    stack.some((n) => n.tag === "pre" || n.tag === "code");

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const token = m[0];
    if (token.charAt(0) !== "<") {
      // 非 pre 内按 HTML 语义折叠空白，并丢掉标签之间的纯缩进文本
      const text = inPre()
        ? decodeEntities(token)
        : decodeEntities(token).replace(/\s+/g, " ");
      if (text.trim().length === 0 && !inPre()) continue;
      append({ text });
      continue;
    }
    const close = closeRe.exec(token);
    if (close) {
      const tag = close[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const open = openRe.exec(token);
    if (!open) continue; // 注释 / DOCTYPE 等
    const tag = open[1].toLowerCase();
    const node: ElementNode = { tag, attrs: parseAttrs(open[2]), children: [] };
    append(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return root;
}

/** 纯文本摘要：去掉标签、块级标签之间补换行 */
export function htmlToText(html: string): string {
  if (!looksLikeHtml(html)) return html;
  const out: string[] = [];
  const walk = (list: Node[]): void => {
    for (const n of list) {
      if ("text" in n) {
        out.push(n.text);
        continue;
      }
      const block = BLOCK_BREAK_TAGS.has(n.tag);
      if (block) out.push("\n");
      if (n.tag === "img" && n.attrs.alt) out.push(n.attrs.alt);
      walk(n.children);
      if (block) out.push("\n");
    }
  };
  walk(parseHtml(stripDangerous(html)));
  return out
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const SAFE_STYLE_KEYS = new Set(["color", "background-color", "text-align"]);
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)$/;
const ALIGN_RE = /^(left|right|center|justify)$/i;

/** 只保留少量安全的行内样式（颜色 / 对齐），其余丢弃 */
function inlineStyle(attrs: Record<string, string>): CSSProperties | undefined {
  const style: Record<string, string> = {};
  for (const decl of (attrs.style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const key = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!SAFE_STYLE_KEYS.has(key) || value.length === 0) continue;
    if (key === "text-align") {
      if (ALIGN_RE.test(value)) style[key] = value;
    } else if (COLOR_RE.test(value)) {
      style[key] = value;
    }
  }
  // <font color="red"> 兼容
  if (!style.color && attrs.color && COLOR_RE.test(attrs.color)) {
    style.color = attrs.color;
  }
  const align = attrs.align;
  if (!style["text-align"] && align && ALIGN_RE.test(align)) {
    style["text-align"] = align;
  }
  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
}

function safeLink(raw: string | undefined): string | null {
  const url = (raw ?? "").trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/** 外部链接：Tauri 侧没有内置的 target=_blank 处理，统一交系统浏览器打开 */
function ExternalLink(props: { href: string; children: ReactNode }): React.JSX.Element {
  return (
    <a
      href={props.href}
      onClick={(e) => {
        e.preventDefault();
        void ipc.openExternalUrl(props.href).catch(() => undefined);
      }}
      className="break-all text-primary underline underline-offset-2"
    >
      {props.children}
    </a>
  );
}

function renderNodes(nodes: Node[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, i) => {
    if ("text" in node) {
      out.push(node.text);
      return;
    }
    out.push(renderElement(node, `${keyPrefix}-${i}`));
  });
  return out;
}

function renderElement(node: ElementNode, key: string): ReactNode {
  const { tag, attrs } = node;
  const inner = renderNodes(node.children, key);
  const style = inlineStyle(attrs);

  switch (tag) {
    case "p":
    case "div":
    case "section":
    case "article":
    case "figure":
    case "figcaption":
      return (
        <p key={key} style={style} className="my-1 first:mt-0 last:mb-0">
          {inner}
        </p>
      );
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} className="my-3 border-border" />;
    case "h1":
      return (
        <h1 key={key} style={style} className="mb-1 mt-3 text-lg font-semibold first:mt-0">
          {inner}
        </h1>
      );
    case "h2":
      return (
        <h2 key={key} style={style} className="mb-1 mt-3 text-base font-semibold first:mt-0">
          {inner}
        </h2>
      );
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return (
        <h3 key={key} style={style} className="mb-1 mt-2 text-sm font-semibold first:mt-0">
          {inner}
        </h3>
      );
    case "strong":
    case "b":
      return (
        <strong key={key} style={style} className="font-semibold">
          {inner}
        </strong>
      );
    case "em":
    case "i":
      return (
        <em key={key} style={style} className="italic">
          {inner}
        </em>
      );
    case "u":
    case "ins":
      return (
        <span key={key} style={style} className="underline underline-offset-2">
          {inner}
        </span>
      );
    case "s":
    case "del":
      return (
        <s key={key} style={style} className="line-through">
          {inner}
        </s>
      );
    case "sub":
      return (
        <sub key={key} style={style}>
          {inner}
        </sub>
      );
    case "sup":
      return (
        <sup key={key} style={style}>
          {inner}
        </sup>
      );
    case "small":
      return (
        <small key={key} style={style} className="text-xs text-muted-foreground">
          {inner}
        </small>
      );
    case "mark":
      return (
        <mark key={key} style={style} className="rounded bg-primary/20 px-0.5 text-foreground">
          {inner}
        </mark>
      );
    case "ul":
      return (
        <ul key={key} style={style} className="my-1 list-disc space-y-0.5 pl-5">
          {inner}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} style={style} className="my-1 list-decimal space-y-0.5 pl-5">
          {inner}
        </ol>
      );
    case "li":
      return (
        <li key={key} style={style}>
          {inner}
        </li>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          style={style}
          className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
        >
          {inner}
        </blockquote>
      );
    case "pre":
      return (
        <pre
          key={key}
          style={style}
          className="my-2 overflow-x-auto whitespace-pre-wrap rounded bg-secondary/60 p-2 text-xs"
        >
          {inner}
        </pre>
      );
    case "code":
      return (
        <code key={key} style={style} className="rounded bg-secondary px-1 py-0.5 text-xs">
          {inner}
        </code>
      );
    case "a": {
      const href = safeLink(attrs.href);
      return href ? (
        <ExternalLink key={key} href={href}>
          {inner}
        </ExternalLink>
      ) : (
        <span key={key} style={style}>
          {inner}
        </span>
      );
    }
    case "img": {
      const src = safeLink(attrs.src);
      if (!src) return null;
      return (
        <img
          key={key}
          src={src}
          alt={attrs.alt ?? ""}
          loading="lazy"
          className="my-2 max-w-full rounded"
        />
      );
    }
    case "table":
      return (
        <table key={key} style={style} className="my-2 w-full border-collapse text-xs">
          {inner}
        </table>
      );
    case "thead":
      return <thead key={key}>{inner}</thead>;
    case "tbody":
      return <tbody key={key}>{inner}</tbody>;
    case "tr":
      return <tr key={key}>{inner}</tr>;
    case "th":
      return (
        <th key={key} style={style} className="border border-border px-2 py-1 text-left font-medium">
          {inner}
        </th>
      );
    case "td":
      return (
        <td key={key} style={style} className="border border-border px-2 py-1 align-top">
          {inner}
        </td>
      );
    default:
      // span / font / 未知标签：当纯容器展开，保留行内样式
      return (
        <span key={key} style={style}>
          {inner}
        </span>
      );
  }
}

/** 纯文本正文：按换行分段，段内 URL 可点 */
function PlainText(props: { text: string }): React.JSX.Element {
  const paragraphs = props.text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (paragraphs.length === 0) {
    return <p className="text-sm text-muted-foreground">（这条消息没有正文）</p>;
  }
  return (
    <div className="space-y-3">
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {splitLinks(p).map((part, j) =>
            part.type === "link" ? (
              <ExternalLink key={j} href={part.value}>
                {part.value}
              </ExternalLink>
            ) : (
              <span key={j}>{part.value}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

export function splitLinks(text: string): { type: "text" | "link"; value: string }[] {
  const parts: { type: "text" | "link"; value: string }[] = [];
  const re = /(https?:\/\/[^\s，。）)、】]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ type: "text", value: text.slice(last, m.index) });
    }
    parts.push({ type: "link", value: m[1] });
    last = m.index + m[1].length;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}

/**
 * 轻量 Markdown（升级说明用）。
 *
 * 后端的 `versionInfo` 一直是 Markdown 风格（`## 新增` + `- **条目**`，见 3.0.9 那条），
 * 以前走 PlainText，`##` 与 `**` 原样露在界面上，而且每条都渲染成独立段落 —— 同样的
 * 内容比真实排版高出一大截，正是「一次性全部展开、把容器撑爆」的来源之一。这里只认
 * 真正的排版标记：标题（#/##/###）、无序列表（- * •）、有序列表（1. `1)`）、加粗、
 * 行内代码、裸链接；其余一律按段落处理，不引入第三方解析器。
 */
function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let seq = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(...linkNodes(text.slice(last, m.index), `${keyPrefix}-t${seq++}`));
    }
    if (m[1] !== undefined) {
      out.push(<strong key={`${keyPrefix}-b${seq}`}>{m[1]}</strong>);
    } else {
      out.push(
        <code key={`${keyPrefix}-c${seq}`} className="rounded bg-secondary px-1 py-0.5 text-xs">
          {m[2]}
        </code>,
      );
    }
    seq += 1;
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(...linkNodes(text.slice(last), `${keyPrefix}-t${seq}`));
  }
  return out;
}

/** 纯文本片段里的裸 URL → 可点链接（与 PlainText 同口径） */
function linkNodes(text: string, keyPrefix: string): ReactNode[] {
  return splitLinks(text).map((part, index) =>
    part.type === "link" ? (
      <ExternalLink key={`${keyPrefix}-l${index}`} href={part.value}>
        {part.value}
      </ExternalLink>
    ) : (
      <span key={`${keyPrefix}-s${index}`}>{part.value}</span>
    ),
  );
}

function MarkdownText(props: { text: string }): React.JSX.Element {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushList = (): void => {
    if (list === null) return;
    const items = list.items.map((item, index) => (
      <li key={`${key}-i${index}`}>{inlineNodes(item, `${key}-i${index}`)}</li>
    ));
    const ordered = list.ordered;
    blocks.push(
      ordered ? (
        <ol key={`l${key++}`} className="ml-5 list-decimal space-y-1 text-sm leading-relaxed">
          {items}
        </ol>
      ) : (
        <ul key={`l${key++}`} className="ml-5 list-disc space-y-1 text-sm leading-relaxed">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  for (const raw of props.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushList();
      const level = heading[1].length;
      const body = inlineNodes(heading[2].trim(), `h${key}`);
      const cls = level <= 2 ? "text-sm font-semibold" : "text-xs font-semibold text-muted-foreground";
      blocks.push(
        level <= 2 ? (
          <h3 key={`h${key++}`} className={cls}>
            {body}
          </h3>
        ) : (
          <h4 key={`h${key++}`} className={cls}>
            {body}
          </h4>
        ),
      );
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      if (list === null || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ordered !== null) {
      if (list === null || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    flushList();
    blocks.push(
      <p key={`p${key++}`} className="whitespace-pre-wrap break-words text-sm leading-relaxed">
        {inlineNodes(line, `p${key}`)}
      </p>,
    );
  }
  flushList();

  if (blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">（这条消息没有正文）</p>;
  }
  return <div className="space-y-2">{blocks}</div>;
}

/**
 * 消息正文：HTML 走富文本渲染，纯文本按段落渲染。
 * `markdown` 为真时把纯文本按轻量 Markdown 排版（升级说明用，默认关闭以免改变
 * 公告/消息既有观感——那边的正文是后端富文本，不是 Markdown）。
 */
export function RichText(props: { text: string; markdown?: boolean }): React.JSX.Element {
  const { text } = props;
  if (!looksLikeHtml(text)) {
    return props.markdown === true ? <MarkdownText text={text} /> : <PlainText text={text} />;
  }
  const nodes = parseHtml(stripDangerous(text));
  if (nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">（这条消息没有正文）</p>;
  }
  return <div className="break-words text-sm leading-relaxed">{renderNodes(nodes, "r")}</div>;
}
