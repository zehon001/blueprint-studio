/**
 * 文本内容处理（T1.2）
 *
 * - sanitizeRichText：richText 节点的 HTML 白名单过滤（防 <script> / 事件属性 / javascript:
 *   URL 注入）；白名单外标签降级为纯文本转义显示。
 * - markdownToHtml：Markdown 轻量转换。本期不引第三方依赖（v1.1 曾用 marked，v2 渲染器
 *   保持零依赖），仅覆盖常用子集：标题 / 粗斜删 / 行内与围栏代码 / 列表 / 引用 / 分隔线 /
 *   链接；复杂语法（表格 / 嵌套列表 / 图片 / HTML 块）降级为纯文本 —— TODO 引入依赖后替换。
 */

/** HTML 转义（文本与属性值共用） */
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/* ============================================================
 * 1. 富文本白名单过滤
 * ============================================================ */

/** 富文本白名单：标签 → 允许保留的属性（style 对全部白名单标签开放，另做内容过滤） */
const RICH_ALLOWED: Record<string, readonly string[]> = {
  b: [], strong: [], i: [], em: [], u: [], s: [], br: [], hr: [],
  p: [], div: [], span: [], ul: [], ol: [], li: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  code: [], pre: [], blockquote: [], small: [], sub: [], sup: [],
  a: ['href', 'title', 'target'],
  img: ['src', 'alt', 'title'],
};

/** 自闭合标签（无结束标签） */
const RICH_VOID = new Set(['br', 'hr', 'img']);

/** 安全 URL：仅 http(s) / mailto / tel / 锚点 / 相对路径 / 图片 data URI */
function safeUrl(v: string): boolean {
  return /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|data:image\/)/i.test(v.trim());
}

/**
 * 属性白名单过滤 + 值转义；返回形如 ` name="v"` 的串（无属性时为空串）。
 * - style 额外剔除 expression( 与 javascript:（简单过滤，够用即可）；
 * - target 只允许 _blank 并强制补 rel="noopener noreferrer"；
 * - href / src 非安全 URL 直接丢弃属性。
 */
function sanitizeAttrs(tag: string, raw: string): string {
  const allowed = [...(RICH_ALLOWED[tag] ?? []), 'style'];
  const out: string[] = [];
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if ((name === 'href' || name === 'src') && !safeUrl(value)) continue;
    let v = value;
    if (name === 'style') v = v.replace(/expression\s*\(/gi, '(').replace(/javascript:/gi, '');
    if (name === 'target') v = '_blank';
    out.push(`${name}="${escapeHtml(v)}"`);
  }
  if (out.some((a) => a.startsWith('target='))) out.push('rel="noopener noreferrer"');
  return out.length ? ` ${out.join(' ')}` : '';
}

/** 标记扫描：script / style 整块、注释、普通标签（属性里含 > 的极端写法不支持——简单白名单够用） */
const RICH_TAG_RE =
  /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;

/**
 * 富文本白名单过滤：
 * - <script>/<style> 块与注释 → 整块丢弃；
 * - 白名单标签 → 重建标签（仅保留白名单属性，值全部转义）；
 * - 其余标签 / 裸文本 → 实体转义后按纯文本显示（降级，不丢内容）。
 */
export function sanitizeRichText(html: string): string {
  const src = String(html ?? '');
  const out: string[] = [];
  let last = 0;
  for (const m of src.matchAll(RICH_TAG_RE)) {
    const idx = m.index ?? 0;
    out.push(escapeHtml(src.slice(last, idx)));
    last = idx + m[0].length;
    // script / style 整块与注释：直接丢弃（m[0] 已吞掉完整块）
    if (m[0].startsWith('<!') || /^<(script|style)\b/i.test(m[0])) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!(tag in RICH_ALLOWED)) {
      out.push(escapeHtml(m[0])); // 非白名单标签 → 降级为可见文本
      continue;
    }
    if (closing || RICH_VOID.has(tag)) {
      // 自闭合 / 结束标签原样收尾（void 标签无需配对）
      out.push(closing ? `</${tag}>` : `<${tag}${sanitizeAttrs(tag, m[3] ?? '')}>`);
      continue;
    }
    out.push(`<${tag}${sanitizeAttrs(tag, m[3] ?? '')}>`);
  }
  out.push(escapeHtml(src.slice(last)));
  return out.join('');
}

/* ============================================================
 * 2. Markdown 轻量转换（零依赖，TODO: 后续可替换为成熟解析器）
 * ============================================================ */

/** 行内语法：`code` / **粗** / *斜* / ~~删~~ / [文本](链接)；图片降级为 alt 文本 */
function mdInline(s: string): string {
  let out = s;
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // 图片：降级为 alt 文本（TODO 渲染 <img>）
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m0, text: string, href: string) =>
    /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : m0, // 非安全链接：保持原文
  );
  return out;
}

/**
 * Markdown → HTML（轻量子集）：
 * 支持 #~###### 标题、段落、粗体/斜体/删除线/行内代码、[链接](url)、围栏代码 ```、
 * 无序/有序列表（单层，嵌套降级平铺）、> 引用、--- 分隔线。
 * 表格等复杂语法无法识别 → 整行按普通段落纯文本显示（降级不丢失）。
 */
export function markdownToHtml(src: string): string {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let fence: string[] | null = null;

  const closePara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const closeQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map(mdInline).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const openList = (tag: 'ul' | 'ol') => {
    if (listTag !== tag) {
      closeList();
      out.push(`<${tag}>`);
      listTag = tag;
    }
  };
  const flushAll = () => {
    closePara();
    closeQuote();
    closeList();
  };

  for (const raw of lines) {
    const t = raw.trim();
    // 围栏代码块（内容原样转义，不做行内转换）
    if (fence !== null) {
      if (/^```/.test(t)) {
        out.push(`<pre><code>${fence.map(escapeHtml).join('\n')}</code></pre>`);
        fence = null;
      } else {
        fence.push(raw);
      }
      continue;
    }
    if (/^```/.test(t)) {
      flushAll();
      fence = [];
      continue;
    }
    if (!t) {
      flushAll(); // 空行 = 块结束
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flushAll();
      out.push(`<h${h[1].length}>${mdInline(escapeHtml(h[2]))}</h${h[1].length}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushAll();
      out.push('<hr>');
      continue;
    }
    const q = /^>\s?(.*)$/.exec(raw);
    if (q) {
      closePara();
      closeList();
      quote.push(escapeHtml(q[1]));
      continue;
    }
    const ul = /^\s*[-*+]\s+(.+)$/.exec(raw);
    if (ul) {
      closePara();
      closeQuote();
      openList('ul');
      out.push(`<li>${mdInline(escapeHtml(ul[1]))}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(raw);
    if (ol) {
      closePara();
      closeQuote();
      openList('ol');
      out.push(`<li>${mdInline(escapeHtml(ol[1]))}</li>`);
      continue;
    }
    // 普通段落行（缩进文本同样进段落；表格等无法识别的行也自然落到这里 = 纯文本降级）
    closeQuote();
    closeList();
    para.push(mdInline(escapeHtml(t)));
  }
  // 收尾：未闭合的围栏按代码块输出，其余块冲刷
  if (fence !== null) out.push(`<pre><code>${fence.map(escapeHtml).join('\n')}</code></pre>`);
  flushAll();
  return out.join('\n');
}
