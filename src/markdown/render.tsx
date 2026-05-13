import type { ReactNode } from "react";
import katex from "katex";

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
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
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
      !/^(#{1,6}\s|[-*]\s|\d+\.\s|>\s|```|\s*\$|---+\s*$)/.test(
        lines[i],
      )
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
