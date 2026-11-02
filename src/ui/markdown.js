/**
 * 問題文・ヒント・解説用の小さな Markdown レンダラです。
 *
 * 対応する書式（問題データは信頼できるリポジトリ内のデータである前提）:
 * - 見出し:   "## 見出し" / "### 見出し" / "#### 見出し"
 * - 箇条書き: "- 項目" / "* 項目"、番号付き "1. 項目"（2スペース字下げで入れ子）
 * - 表:       "| a | b |" の行の並び（2行目が "|---|---|" ならヘッダー）
 * - 引用:     "> 文"
 * - 段落:     空行区切り。段落内の改行は <br>
 * - 強調:     **太字**、`コード`
 * - 数式:     $インライン$、$$ ディスプレイ $$（KaTeX があれば描画、無ければ等幅表示）
 * - 図:       行頭が "<svg" で始まり "</svg>" で終わるブロックはそのまま出力
 */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMath(tex, displayMode) {
  const katex = typeof window !== "undefined" ? window.katex : null;

  if (katex && typeof katex.renderToString === "function") {
    try {
      return katex.renderToString(tex, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        output: "html",
      });
    } catch {
      /* フォールバックへ */
    }
  }

  const cls = displayMode ? "md-math md-math-display" : "md-math";
  return `<span class="${cls}">${escapeHtml(tex)}</span>`;
}

/**
 * インライン要素を変換します。数式を先に退避してからエスケープします。
 */
function renderInline(text) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let s = String(text ?? "");

  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => keep(renderMath(tex.trim(), true)));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, tex) => keep(renderMath(tex.trim(), false)));
  s = s.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));

  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

function renderList(lines) {
  // lines: [{indent, ordered, text}]
  let html = "";
  const stack = [];

  for (const item of lines) {
    while (stack.length && item.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }

    let top = stack[stack.length - 1];
    const tagWanted = item.ordered ? "ol" : "ul";

    if (top && item.indent === top.indent && top.tag !== tagWanted) {
      html += `</li></${stack.pop().tag}>`;
      top = stack[stack.length - 1];
    }

    if (!top || item.indent > top.indent) {
      const tag = item.ordered ? "ol" : "ul";
      stack.push({ indent: item.indent, tag });
      html += `<${tag}><li>${renderInline(item.text)}`;
    } else {
      html += `</li><li>${renderInline(item.text)}`;
    }
  }

  while (stack.length) {
    html += `</li></${stack.pop().tag}>`;
  }

  return html;
}

function renderTable(rows) {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const hasHeader = rows.length > 1 && /^\s*\|?\s*:?-{2,}/.test(rows[1]);
  let html = `<div class="md-table-wrap"><table class="md-table">`;

  if (hasHeader) {
    html += `<thead><tr>${cells(rows[0]).map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
  }

  const body = hasHeader ? rows.slice(2) : rows;
  html += `<tbody>${body
    .map((r) => `<tr>${cells(r).map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;

  return html;
}

/**
 * Markdown サブセットを HTML に変換します。
 *
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  const isBlank = (l) => /^\s*$/.test(l);
  const listRe = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // SVG ブロック
    if (/^\s*<svg[\s>]/.test(line)) {
      const buf = [];
      while (i < lines.length) {
        buf.push(lines[i]);
        if (/<\/svg>\s*$/.test(lines[i])) {
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(`<div class="md-figure">${buf.join("\n")}</div>`);
      continue;
    }

    // ディスプレイ数式ブロック（$$ だけの行で囲む）
    if (/^\s*\$\$\s*$/.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<div class="md-display">${renderMath(buf.join("\n"), true)}</div>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level} class="md-h">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (m) {
          items.push({
            indent: m[1].replace(/\t/g, "  ").length,
            ordered: /\d/.test(m[2]),
            text: m[3],
          });
          i += 1;
        } else if (!isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && items.length) {
          // 継続行
          items[items.length - 1].text += " " + lines[i].trim();
          i += 1;
        } else {
          break;
        }
      }
      out.push(renderList(items));
      continue;
    }

    // 段落
    const buf = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !listRe.test(lines[i]) &&
      !/^\s*[|>]/.test(lines[i]) &&
      !/^\s*\$\$\s*$/.test(lines[i]) &&
      !/^\s*<svg[\s>]/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${buf.map(renderInline).join("<br>")}</p>`);
  }

  return out.join("\n");
}
