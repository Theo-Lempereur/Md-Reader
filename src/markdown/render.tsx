import type { CSSProperties, ReactNode } from "react";
import katex from "katex";
import { Icon } from "../components/Icons";

export type BlockInfo = {
  key: number;
  kind: string;
  lineStart: number;
  lineEnd: number;
  sourceLines: string[];
};

export type BlockRenderOpts = {
  onInspect: (block: BlockInfo) => void;
  onOpenFull: (block: BlockInfo) => void;
  selectedBlockKey: number | null;
  inspectMode: "block" | "full" | null;
  /** Bloc surligné des deux côtés (preview + source) après un saut. */
  highlightedBlockKey?: number | null;
  blockEls: React.MutableRefObject<
    Map<number, { el: HTMLDivElement; lineStart: number; lineEnd: number }>
  >;
};

type InlineMathSegment =
  | { type: "text"; value: string }
  | { type: "math"; value: string };

function normalizeTex(tex: string): string {
  return tex
    .replace(/\\{2,}([A-Za-z]+)/g, "\\$1")
    .replace(/\\{2,}([,;:!])/g, "\\$1")
    .replace(/\\+_/g, "_")
    .replace(/\\+([\[\]])/g, "$1")
    .replace(/\\legslant\b/g, "\\leqslant")
    .replace(/\\gegslant\b/g, "\\geqslant");
}

function renderMath(tex: string, displayMode: boolean, key: number): ReactNode {
  const normalizedTex = normalizeTex(tex);

  return (
    <span
      key={key}
      className={displayMode ? "math-block" : "math-inline"}
      data-tex={tex}
      data-display={displayMode ? "true" : "false"}
      contentEditable={false}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(normalizedTex, {
          displayMode,
          throwOnError: false,
          strict: "ignore",
          trust: false,
        }),
      }}
    />
  );
}

function isUnescapedDollar(text: string, index: number): boolean {
  if (text[index] !== "$") return false;

  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 0;
}

function splitInlineMath(text: string): InlineMathSegment[] {
  const segments: InlineMathSegment[] = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    if (
      text[i] === "$" &&
      text[i + 1] !== "$" &&
      isUnescapedDollar(text, i)
    ) {
      let end = i + 1;
      while (end < text.length) {
        if (
          text[end] === "$" &&
          text[end + 1] !== "$" &&
          isUnescapedDollar(text, end)
        ) {
          break;
        }
        end++;
      }

      if (end < text.length && end > i + 1) {
        if (start < i) segments.push({ type: "text", value: text.slice(start, i) });
        segments.push({ type: "math", value: text.slice(i + 1, end) });
        start = end + 1;
        i = end + 1;
        continue;
      }
    }
    i++;
  }

  if (start < text.length) segments.push({ type: "text", value: text.slice(start) });
  return segments;
}

export function inlineRender(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|~~[^~\n]+~~)/g;
  let i = 0;

  for (const segment of splitInlineMath(text)) {
    if (segment.type === "math") {
      out.push(renderMath(segment.value, false, i++));
      continue;
    }

    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(segment.value))) {
      if (m.index > last) out.push(segment.value.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) {
        out.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
      } else if (tok.startsWith("~~")) {
        out.push(<del key={i++}>{tok.slice(2, -2)}</del>);
      } else if (tok.startsWith("*")) {
        out.push(<em key={i++}>{tok.slice(1, -1)}</em>);
      } else if (tok.startsWith("`")) {
        out.push(<code key={i++}>{tok.slice(1, -1)}</code>);
      } else if (tok.startsWith("[")) {
        const lm = tok.match(/\[([^\]]+)\]\(([^)\n]+)\)/);
        if (lm) {
          out.push(
            <a key={i++} href={lm[2]} onClick={(e) => e.preventDefault()}>
              {lm[1]}
            </a>,
          );
        }
      }
      last = m.index + tok.length;
    }
    if (last < segment.value.length) out.push(segment.value.slice(last));
  }

  return out;
}

type ListItem = { task: boolean; done?: boolean; text: string };
type TableAlign = "left" | "center" | "right" | null;
type MarkdownTable = {
  headers: string[];
  aligns: TableAlign[];
  rows: string[][];
  lineEnd: number;
};

const ORDERED_LIST_RE = /^\d+\\*\.\s/;
const ORDERED_LIST_PREFIX_RE = /^\d+\\*\.\s+/;
const BLOCK_START_RE = /^(#{1,6}\s|[-*]\s|\d+\\*\.\s|>\s|```|\s*\$|---+\s*$)/;

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !isEscaped(text, text.length - 1)) {
    text = text.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";
  let inCode = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "`" && !isEscaped(text, i)) inCode = !inCode;
    if (char === "|" && !inCode && !isEscaped(text, i)) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    if (char === "\\" && text[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseTableDivider(line: string): TableAlign[] | null {
  if (!line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (!cells.length) return null;

  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  return aligns;
}

function normalizeTableCells<T>(cells: T[], colCount: number, fill: T): T[] {
  if (cells.length >= colCount) return cells.slice(0, colCount);
  return [...cells, ...Array.from({ length: colCount - cells.length }, () => fill)];
}

function parseTableAt(lines: string[], start: number): MarkdownTable | null {
  if (start + 1 >= lines.length || !lines[start].includes("|")) return null;

  const headerCells = splitTableRow(lines[start]);
  const dividerAligns = parseTableDivider(lines[start + 1]);
  if (!dividerAligns || headerCells.length < 1) return null;

  let i = start + 2;
  const bodyRows: string[][] = [];
  while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
    if (parseTableDivider(lines[i])) break;
    bodyRows.push(splitTableRow(lines[i]));
    i++;
  }

  const colCount = Math.max(
    headerCells.length,
    dividerAligns.length,
    ...bodyRows.map((row) => row.length),
  );

  return {
    headers: normalizeTableCells(headerCells, colCount, ""),
    aligns: normalizeTableCells<TableAlign>(dividerAligns, colCount, null),
    rows: bodyRows.map((row) => normalizeTableCells(row, colCount, "")),
    lineEnd: i - 1,
  };
}

function tableAlignStyle(align: TableAlign): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}

export function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Heading
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const lvl = m[1].length;
      const content = inlineRender(m[2]);
      switch (lvl) {
        case 1:
          blocks.push(<h1 key={key++}>{content}</h1>);
          break;
        case 2:
          blocks.push(<h2 key={key++}>{content}</h2>);
          break;
        case 3:
          blocks.push(<h3 key={key++}>{content}</h3>);
          break;
        case 4:
          blocks.push(<h4 key={key++}>{content}</h4>);
          break;
        case 5:
          blocks.push(<h5 key={key++}>{content}</h5>);
          break;
        default:
          blocks.push(<h6 key={key++}>{content}</h6>);
      }
      i++;
      continue;
    }
    // HR
    if (/^---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }
    // Blockquote
    if (/^>\s?/.test(line)) {
      const ps: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        ps.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++}>
          {ps.map((p, k) => (
            <p key={k}>{inlineRender(p)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }
    // Code fence
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key++}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // Display math
    if (/^\s*\$\$/.test(line)) {
      const body: string[] = [];
      const openingRest = line.replace(/^\s*\$\$\s?/, "");

      if (openingRest.includes("$$")) {
        body.push(openingRest.replace(/\s?\$\$\s*$/, ""));
        i++;
      } else {
        if (openingRest.trim()) body.push(openingRest);
        i++;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          body.push(lines[i].replace(/\s?\$\$\s*$/, ""));
          i++;
        }
      }

      blocks.push(
        <div key={key++} className="math-display">
          {renderMath(body.join("\n").trim(), true, 0)}
        </div>,
      );
      continue;
    }
    // Multiline math with single-dollar delimiters.
    if (/^\s*\$(?!\$)/.test(line)) {
      const body: string[] = [];
      const openingRest = line.replace(/^\s*\$\s?/, "");

      if (openingRest.includes("$")) {
        body.push(openingRest.replace(/\s?\$\s*$/, ""));
        i++;
      } else {
        if (openingRest.trim()) body.push(openingRest);
        i++;
        while (i < lines.length && !/\$\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          body.push(lines[i].replace(/\s?\$\s*$/, ""));
          i++;
        }
      }

      blocks.push(
        <div key={key++} className="math-display">
          {renderMath(body.join("\n").trim(), true, 0)}
        </div>,
      );
      continue;
    }
    // Table
    const table = parseTableAt(lines, i);
    if (table) {
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {table.headers.map((cell, col) => (
                  <th
                    key={col}
                    data-align={table.aligns[col] ?? undefined}
                    style={tableAlignStyle(table.aligns[col])}
                  >
                    {inlineRender(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {row.map((cell, col) => (
                    <td
                      key={col}
                      data-align={table.aligns[col] ?? undefined}
                      style={tableAlignStyle(table.aligns[col])}
                    >
                      {inlineRender(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = table.lineEnd + 1;
      continue;
    }
    // Unordered list (incl. task)
    if (/^[-*]\s/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        const txt = lines[i].replace(/^[-*]\s+/, "");
        const tm = txt.match(/^\[([ xX])\]\s+(.*)$/);
        if (tm) {
          items.push({
            task: true,
            done: tm[1].toLowerCase() === "x",
            text: tm[2],
          });
        } else {
          items.push({ task: false, text: txt });
        }
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, k) => (
            <li
              key={k}
              className={it.task ? `task-li ${it.done ? "done" : ""}` : ""}
            >
              {it.task && (
                <input type="checkbox" checked={!!it.done} readOnly />
              )}
              <span>{inlineRender(it.text)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    // Ordered list
    if (ORDERED_LIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ORDERED_LIST_RE.test(lines[i])) {
        items.push(lines[i].replace(ORDERED_LIST_PREFIX_RE, ""));
        i++;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((t, k) => (
            <li key={k}>{inlineRender(t)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    // Empty
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph
    const ps: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_START_RE.test(lines[i]) &&
      !parseTableAt(lines, i)
    ) {
      ps.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{inlineRender(ps.join(" "))}</p>);
  }

  return blocks;
}

export function wordCount(t: string): number {
  return (t.trim().match(/\S+/g) || []).length;
}
export function readTime(t: string): number {
  return Math.max(1, Math.ceil(wordCount(t) / 220));
}

// ── Block position tracking (for renderMarkdownBlocks) ──────────────────────

export type BlockBounds = { lineStart: number; lineEnd: number; kind: string };

export function parseBlockBounds(md: string): BlockBounds[] {
  const lines = md.split("\n");
  const bounds: BlockBounds[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineStart = i;
    const line = lines[i];

    if (/^(#{1,6})\s+/.test(line)) {
      const lvl = line.match(/^(#{1,6})/)?.[1].length ?? 1;
      i++;
      bounds.push({ lineStart, lineEnd: i - 1, kind: `titre H${lvl}` });
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      i++;
      bounds.push({ lineStart, lineEnd: i - 1, kind: "séparateur" });
      continue;
    }
    if (/^>\s?/.test(line)) {
      while (i < lines.length && /^>\s?/.test(lines[i])) i++;
      bounds.push({ lineStart, lineEnd: i - 1, kind: "citation" });
      continue;
    }
    if (/^```/.test(line)) {
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) i++;
      i++;
      bounds.push({ lineStart, lineEnd: i - 1, kind: "code" });
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      const openingRest = line.replace(/^\s*\$\$\s?/, "");
      if (openingRest.includes("$$")) {
        i++;
      } else {
        i++;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) i++;
        if (i < lines.length) i++;
      }
      bounds.push({ lineStart, lineEnd: i - 1, kind: "formule" });
      continue;
    }
    if (/^\s*\$(?!\$)/.test(line)) {
      const openingRest = line.replace(/^\s*\$\s?/, "");
      if (openingRest.includes("$")) {
        i++;
      } else {
        i++;
        while (i < lines.length && !/\$\s*$/.test(lines[i])) i++;
        if (i < lines.length) i++;
      }
      bounds.push({ lineStart, lineEnd: i - 1, kind: "formule" });
      continue;
    }
    const table = parseTableAt(lines, i);
    if (table) {
      i = table.lineEnd + 1;
      bounds.push({ lineStart, lineEnd: i - 1, kind: "tableau" });
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      while (i < lines.length && /^[-*]\s/.test(lines[i])) i++;
      const hasTasks = lines
        .slice(lineStart, i)
        .some((l) => /^[-*]\s\[/.test(l));
      bounds.push({
        lineStart,
        lineEnd: i - 1,
        kind: hasTasks ? "liste de tâches" : "liste",
      });
      continue;
    }
    if (ORDERED_LIST_RE.test(line)) {
      while (i < lines.length && ORDERED_LIST_RE.test(lines[i])) i++;
      bounds.push({ lineStart, lineEnd: i - 1, kind: "liste numérotée" });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_START_RE.test(lines[i]) &&
      !parseTableAt(lines, i)
    )
      i++;
    bounds.push({ lineStart, lineEnd: i - 1, kind: "paragraphe" });
  }

  return bounds;
}

export function renderMarkdownBlocks(
  md: string,
  opts: BlockRenderOpts,
): ReactNode[] {
  const rendered = renderMarkdown(md);
  const bounds = parseBlockBounds(md);
  const lines = md.split("\n");

  return rendered.map((jsx, idx) => {
    const b = bounds[idx] ?? { lineStart: 0, lineEnd: 0, kind: "paragraphe" };
    const info: BlockInfo = {
      key: idx,
      kind: b.kind,
      lineStart: b.lineStart,
      lineEnd: b.lineEnd,
      sourceLines: lines.slice(b.lineStart, b.lineEnd + 1),
    };
    const isBlockSel =
      opts.selectedBlockKey === idx && opts.inspectMode === "block";
    const isFull = opts.inspectMode === "full";
    const isHighlighted = opts.highlightedBlockKey === idx;

    return (
      <div
        key={idx}
        className={`md-block${isBlockSel ? " selected" : ""}${isHighlighted ? " jump-highlight" : ""}`}
        ref={(el) => {
          if (el)
            opts.blockEls.current.set(idx, {
              el,
              lineStart: b.lineStart,
              lineEnd: b.lineEnd,
            });
          else opts.blockEls.current.delete(idx);
        }}
      >
        <div className="md-block-inner">
          {jsx}
          <div className="md-block-tools">
            <button
              className={`md-block-btn${isBlockSel ? " active" : ""}`}
              title={`Source du bloc — ${b.kind}`}
              onClick={(e) => {
                e.stopPropagation();
                opts.onInspect(info);
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Icon.Code />
            </button>
            <button
              className={`md-block-btn${isFull ? " active" : ""}`}
              title="Source complète synchronisée"
              onClick={(e) => {
                e.stopPropagation();
                opts.onOpenFull(info);
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Icon.PanelRight />
            </button>
          </div>
        </div>
      </div>
    );
  });
}
