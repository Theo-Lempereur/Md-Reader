import type { ReactNode } from "react";

const TIPS: Record<string, string> = {
  "#": "Titre niveau 1",
  "##": "Titre niveau 2",
  "###": "Titre niveau 3",
  "####": "Titre niveau 4",
  "**": "Gras",
  "*": "Italique",
  "`": "Code en ligne",
  "~~": "Barré",
  "-": "Liste à puces",
  ">": "Citation",
  "---": "Séparateur",
  "[": "Lien : [texte]",
  "](": "Lien : (url)",
  ")": "",
  "[ ]": "Tâche à faire",
  "[x]": "Tâche terminée",
  "|": "Tableau",
};

const ORDERED_LIST_LINE_RE = /^(\d+\\*\.)(\s+)(.*)$/;
const ORDERED_LIST_MARKER_RE = /^\d+\\*\.\s/;

function withTip(content: string, tip: string, key: string): ReactNode {
  return (
    <span key={key} className="md-syntax md-tip" data-tip={tip}>
      {content}
    </span>
  );
}

function inlineTokens(text: string, baseKey: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|~~[^~\n]+~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push(
        <span key={`${baseKey}-t-${i++}`}>{text.slice(last, m.index)}</span>,
      );
    }
    const tok = m[0];
    const k = `${baseKey}-${i++}`;
    if (tok.startsWith("**")) {
      out.push(
        <span key={k}>
          {withTip("**", TIPS["**"], `${k}-a`)}
          <span className="md-bold">{tok.slice(2, -2)}</span>
          {withTip("**", TIPS["**"], `${k}-b`)}
        </span>,
      );
    } else if (tok.startsWith("~~")) {
      out.push(
        <span key={k}>
          {withTip("~~", TIPS["~~"], `${k}-a`)}
          <span className="md-strike">{tok.slice(2, -2)}</span>
          {withTip("~~", TIPS["~~"], `${k}-b`)}
        </span>,
      );
    } else if (tok.startsWith("*")) {
      out.push(
        <span key={k}>
          {withTip("*", TIPS["*"], `${k}-a`)}
          <span className="md-italic">{tok.slice(1, -1)}</span>
          {withTip("*", TIPS["*"], `${k}-b`)}
        </span>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <span key={k}>
          {withTip("`", TIPS["`"], `${k}-a`)}
          <span className="md-code">{tok.slice(1, -1)}</span>
          {withTip("`", TIPS["`"], `${k}-b`)}
        </span>,
      );
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) {
        out.push(
          <span key={k}>
            <span className="md-syntax md-tip" data-tip={TIPS["["]}>
              [
            </span>
            <span className="md-link-text">{lm[1]}</span>
            <span className="md-syntax md-tip" data-tip={TIPS["]("]}>
              ](
            </span>
            <span className="md-link-url">{lm[2]}</span>
            <span className="md-syntax">)</span>
          </span>,
        );
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    out.push(<span key={`${baseKey}-end`}>{text.slice(last)}</span>);
  }
  return out;
}

export function tokenizeLine(line: string, lineNum: number): ReactNode {
  const baseKey = `l${lineNum}`;
  // Heading
  let m = line.match(/^(#{1,6})(\s+)(.*)$/);
  if (m) {
    const lvl = m[1].length;
    return (
      <>
        <span
          className="md-syntax md-tip"
          data-tip={TIPS[m[1]] || `Titre niveau ${lvl}`}
        >
          {m[1]}
        </span>
        <span>{m[2]}</span>
        <span className={`md-heading-${Math.min(lvl, 3)}`}>
          {inlineTokens(m[3], baseKey)}
        </span>
      </>
    );
  }
  // Table row
  if (/^\s*\|.*\|\s*$/.test(line)) {
    const parts: ReactNode[] = [];
    const re = /(\|)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let i = 0;

    while ((match = re.exec(line))) {
      if (match.index > last) {
        const cellText = line.slice(last, match.index);
        const isDivider = /^:?-{3,}:?$/.test(cellText.trim());
        parts.push(
          <span
            key={`${baseKey}-table-cell-${i++}`}
            className={isDivider ? "md-table-divider" : undefined}
          >
            {isDivider ? cellText : inlineTokens(cellText, `${baseKey}-table-${i}`)}
          </span>,
        );
      }
      parts.push(withTip("|", TIPS["|"], `${baseKey}-table-pipe-${i++}`));
      last = match.index + 1;
    }
    if (last < line.length) {
      parts.push(
        <span key={`${baseKey}-table-end-${i++}`}>
          {inlineTokens(line.slice(last), `${baseKey}-table-end`)}
        </span>,
      );
    }
    return <>{parts}</>;
  }
  // Task list item
  m = line.match(/^([-*])(\s+)\[([ xX])\](\s+)(.*)$/);
  if (m) {
    return (
      <>
        <span className="md-syntax md-tip" data-tip={TIPS["-"]}>
          {m[1]}
        </span>
        <span>{m[2]}</span>
        <span
          className="md-syntax md-tip"
          data-tip={m[3].toLowerCase() === "x" ? TIPS["[x]"] : TIPS["[ ]"]}
        >
          [{m[3]}]
        </span>
        <span>{m[4]}</span>
        {inlineTokens(m[5], baseKey)}
      </>
    );
  }
  // Unordered list
  m = line.match(/^([-*])(\s+)(.*)$/);
  if (m) {
    return (
      <>
        <span className="md-syntax md-tip" data-tip={TIPS["-"]}>
          {m[1]}
        </span>
        <span>{m[2]}</span>
        {inlineTokens(m[3], baseKey)}
      </>
    );
  }
  // Ordered list
  m = line.match(ORDERED_LIST_LINE_RE);
  if (m) {
    return (
      <>
        <span className="md-syntax md-tip" data-tip="Liste numérotée">
          {m[1]}
        </span>
        <span>{m[2]}</span>
        {inlineTokens(m[3], baseKey)}
      </>
    );
  }
  // Blockquote
  m = line.match(/^(>)(\s+)(.*)$/);
  if (m) {
    return (
      <>
        <span className="md-syntax md-tip" data-tip={TIPS[">"]}>
          {m[1]}
        </span>
        <span>{m[2]}</span>
        <span style={{ fontStyle: "italic", color: "var(--text-2)" }}>
          {inlineTokens(m[3], baseKey)}
        </span>
      </>
    );
  }
  // HR
  if (/^---+\s*$/.test(line)) {
    return (
      <span className="md-syntax md-tip" data-tip={TIPS["---"]}>
        {line}
      </span>
    );
  }
  // Code fence
  if (/^```/.test(line)) {
    return (
      <span className="md-syntax md-tip" data-tip="Bloc de code">
        {line}
      </span>
    );
  }
  return <>{inlineTokens(line, baseKey)}</>;
}

export function marginIcon(
  line: string,
): { label: string; cls: string } | null {
  if (/^#\s/.test(line)) return { label: "H1", cls: "h1" };
  if (/^##\s/.test(line)) return { label: "H2", cls: "h2" };
  if (/^###\s/.test(line)) return { label: "H3", cls: "h3" };
  if (/^####\s/.test(line)) return { label: "H4", cls: "h3" };
  if (/^[-*]\s\[/.test(line)) return { label: "☐", cls: "list" };
  if (/^[-*]\s/.test(line)) return { label: "•", cls: "list" };
  if (ORDERED_LIST_MARKER_RE.test(line)) return { label: "№", cls: "list" };
  if (/^\s*\|.*\|\s*$/.test(line)) return { label: "▦", cls: "table" };
  if (/^>\s/.test(line)) return { label: '"', cls: "quote" };
  if (/^```/.test(line)) return { label: "</>", cls: "code" };
  if (/^---+\s*$/.test(line)) return { label: "—", cls: "hr" };
  return null;
}

export function highlightSearch(
  line: string,
  q: string,
  lineIdx: number,
  current: { line: number; start: number } | null,
): ReactNode {
  if (!q) return tokenizeLine(line, lineIdx);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push(<span key={i++}>{line.slice(last, m.index)}</span>);
    const isCurrent =
      current && current.line === lineIdx && current.start === m.index;
    parts.push(
      <span
        key={i++}
        className={`search-hit ${isCurrent ? "current" : ""}`}
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(<span key={i++}>{line.slice(last)}</span>);
  return parts.length ? <>{parts}</> : <span>{"​"}</span>;
}
