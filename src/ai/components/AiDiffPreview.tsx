import { cloneElement, Fragment, isValidElement, useMemo, useState, type ReactNode } from "react";
import { renderMarkdown } from "../../markdown/render";
import {
  DEL_END,
  DEL_START,
  INS_END,
  INS_START,
  markCount,
  type PvBlock,
  type PvCard,
  type PvItem,
} from "../diff/preview";

/** Remplace les sentinelles d'une source fusionnée, une fois rendue, par des
 * <del>/<ins>. L'état (dans un passage supprimé / ajouté) traverse les
 * éléments : un passage peut commencer dans du gras et finir après.
 * `null` si une sentinelle a atterri hors du texte (lien, image, formule) :
 * l'appelant retombe alors sur l'affichage ancien / nouveau bloc. */
function renderMerged(merged: string): ReactNode[] | null {
  let mode: "" | "del" | "ins" = "";
  let seen = 0;
  let key = 0;

  const visitText = (text: string): ReactNode => {
    if (!mode && !/[\uE000-\uE003]/.test(text)) return text;
    const out: ReactNode[] = [];
    let buf = "";
    const flush = () => {
      if (!buf) return;
      if (mode === "del") out.push(<del key={key++} className="ai-pv-del">{buf}</del>);
      else if (mode === "ins") out.push(<ins key={key++} className="ai-pv-ins">{buf}</ins>);
      else out.push(buf);
      buf = "";
    };
    for (const ch of text) {
      if (ch === DEL_START || ch === DEL_END || ch === INS_START || ch === INS_END) {
        flush();
        mode = ch === DEL_START ? "del" : ch === INS_START ? "ins" : "";
        seen++;
      } else buf += ch;
    }
    flush();
    return <Fragment key={key++}>{out}</Fragment>;
  };

  const visit = (node: ReactNode): ReactNode => {
    if (typeof node === "string") return visitText(node);
    if (Array.isArray(node)) return node.map(visit);
    if (isValidElement<{ children?: ReactNode }>(node) && node.props.children != null) {
      return cloneElement(node, undefined, visit(node.props.children));
    }
    return node;
  };

  const nodes = renderMarkdown(merged).map(visit);
  return seen === markCount(merged) ? nodes : null;
}

function Block({ block, kind }: { block: PvBlock; kind: "same" | "del" | "add" }) {
  return <div className={`ai-pv-item ${kind}`}>{renderMarkdown(block.source)}</div>;
}

function Item({ item }: { item: PvItem }) {
  const merged = useMemo(
    () => (item.type === "edit" ? renderMerged(item.merged) : null),
    [item],
  );
  if (item.type !== "edit") return <Block block={item.block} kind={item.type} />;
  if (merged) return <div className="ai-pv-item edit">{merged}</div>;
  return (
    <>
      <Block block={item.old} kind="del" />
      <Block block={item.next} kind="add" />
    </>
  );
}

const SAME_KEEP = 1;

/** Aperçu rendu d'une carte : blocs inchangés atténués, blocs supprimés barrés,
 * blocs ajoutés surlignés, modifications mot à mot à l'intérieur des blocs. */
export function AiDiffPreview({ card }: { card: PvCard }) {
  const [expanded, setExpanded] = useState(false);
  if (!card.items.length) {
    return (
      <div className="ai-pv-body">
        <p className="ai-muted ai-pv-empty">
          Mise en page uniquement (lignes vides) : aucun changement visible à la lecture.
        </p>
      </div>
    );
  }
  const rows: (PvItem | { fold: number; key: string })[] = [];
  let i = 0;
  while (i < card.items.length) {
    if (card.items[i].type !== "same") {
      rows.push(card.items[i++]);
      continue;
    }
    let j = i;
    while (j < card.items.length && card.items[j].type === "same") j++;
    const run = card.items.slice(i, j);
    const hidden = run.length - SAME_KEEP * 2;
    if (!expanded && hidden > 1) {
      rows.push(...run.slice(0, SAME_KEEP), { fold: hidden, key: `f${i}` }, ...run.slice(-SAME_KEEP));
    } else rows.push(...run);
    i = j;
  }
  return (
    <div className="ai-pv-body reading">
      {rows.map((row, idx) =>
        "fold" in row ? (
          <button key={row.key} type="button" className="ai-fold ai-pv-fold" onClick={() => setExpanded(true)}>
            ⋯ {row.fold} bloc{row.fold > 1 ? "s" : ""} inchangé{row.fold > 1 ? "s" : ""}
          </button>
        ) : (
          <Item key={idx} item={row} />
        ),
      )}
    </div>
  );
}
