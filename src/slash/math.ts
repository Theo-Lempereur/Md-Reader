import katex from "katex";
import type { SlashCommand } from "./commands";
import {
  clearTriggerText,
  dispatchInput,
  jumpToNextPlaceholder,
  MATH_PLACEHOLDER,
  placeCaretAtFirstPlaceholder,
  type SlashCtx,
} from "./runners";

/* ============================================================
 * Détection du contexte math
 * ============================================================ */

/** Sélecteur du span éditable (mode édition d'une formule). */
export const MATH_EDIT_SELECTOR = ".math-edit";

/** Sélecteur des blocs rendus (KaTeX read-only). */
export const MATH_RENDERED_SELECTOR =
  ".math-inline, .math-block, .math-display";

export function isInsideMathEdit(editor: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).startContainer;
  if (!editor.contains(node)) return false;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return !!el?.closest(MATH_EDIT_SELECTOR);
}

/** Trouve le span `.math-edit` qui contient le caret (ou null). */
export function findActiveMathEdit(editor: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  if (!editor.contains(node)) return null;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return (el?.closest(MATH_EDIT_SELECTOR) as HTMLElement | null) ?? null;
}

/* ============================================================
 * Entrée / sortie du mode édition math
 * ============================================================ */

const ZWSP = "​";

function buildEditSpan(display: boolean, initialTex = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = "math-edit";
  span.setAttribute("data-display", display ? "true" : "false");
  span.setAttribute("data-tex", initialTex);
  span.setAttribute("spellcheck", "false");
  span.contentEditable = "true";
  // Un ZWSP garantit la présence d'un text node éditable même si la
  // formule est vide — utile pour positionner le caret.
  span.appendChild(document.createTextNode(initialTex || ZWSP));
  return span;
}

function wrapDisplay(span: HTMLElement): HTMLElement {
  const div = document.createElement("div");
  div.className = "math-edit-wrap";
  div.appendChild(span);
  return div;
}

/** Insère un span editable au caret. Le caret se place à l'intérieur. */
export function enterMathEdit(ctx: SlashCtx, display: boolean): void {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  ctx.editor.focus();

  const span = buildEditSpan(display);
  const insertable: Node = display ? wrapDisplay(span) : span;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    ctx.editor.appendChild(insertable);
  } else {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(insertable);
  }

  // Place le caret dans le span (offset 1 si on a un ZWSP, sinon 0).
  const text = span.firstChild as Text | null;
  if (text) {
    const r = document.createRange();
    r.setStart(text, text.data.length);
    r.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  dispatchInput(ctx.editor);
}

/** Lit le TeX brut depuis un span d'édition (ignore le ZWSP). */
function readTexFromEditSpan(span: HTMLElement): string {
  return (span.textContent ?? "").replace(/​/g, "");
}

/** Rend un span éditable en formule KaTeX figée. Renvoie l'élément rendu
 * (utile pour positionner le caret après). */
function commitMathEdit(span: HTMLElement): HTMLElement {
  const display = span.getAttribute("data-display") === "true";
  const tex = readTexFromEditSpan(span);

  const rendered = document.createElement("span");
  rendered.className = display ? "math-block" : "math-inline";
  rendered.setAttribute("data-tex", tex);
  rendered.setAttribute("data-display", display ? "true" : "false");
  rendered.contentEditable = "false";

  try {
    rendered.innerHTML = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
  } catch {
    rendered.textContent = tex;
  }

  // Pour display, on l'enveloppe dans .math-display (cohérent avec le rendu
  // du parser markdown).
  if (display) {
    const wrap = document.createElement("div");
    wrap.className = "math-display";
    wrap.appendChild(rendered);
    // Remplace soit le wrap d'édition, soit le span seul selon ce qui est en DOM
    const target = span.parentElement?.classList.contains("math-edit-wrap")
      ? span.parentElement
      : span;
    target.replaceWith(wrap);
    return wrap;
  } else {
    span.replaceWith(rendered);
    return rendered;
  }
}

/** Quitte le mode édition : rend la formule et place le caret juste après. */
export function exitMathEdit(ctx: SlashCtx): void {
  const span = findActiveMathEdit(ctx.editor);
  if (!span) return;
  // On supprime d'abord le /exit dans le span avant de lire le TeX.
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);

  const rendered = commitMathEdit(span);
  ctx.editor.focus();
  const sel = window.getSelection();
  if (sel) {
    const r = document.createRange();
    r.setStartAfter(rendered);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  dispatchInput(ctx.editor);
}

/** Ferme tous les `.math-edit` ouverts dans l'éditeur (utilisé sur blur ou
 * quand le caret quitte le bloc). */
export function commitAllOpenMathEdits(editor: HTMLElement): void {
  const spans = Array.from(editor.querySelectorAll<HTMLElement>(MATH_EDIT_SELECTOR));
  let touched = false;
  for (const span of spans) {
    commitMathEdit(span);
    touched = true;
  }
  if (touched) dispatchInput(editor);
}

/** Commit l'éventuel `.math-edit` contenant le caret. Renvoie `true` si une
 * formule a été rendue (le caller doit alors `preventDefault`), `false`
 * sinon (laisser passer l'événement clavier). */
export function commitActiveMathEdit(editor: HTMLElement): boolean {
  const span = findActiveMathEdit(editor);
  if (!span) return false;
  const rendered = commitMathEdit(span);
  editor.focus();
  const sel = window.getSelection();
  if (sel) {
    const r = document.createRange();
    r.setStartAfter(rendered);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  dispatchInput(editor);
  return true;
}

/* ============================================================
 * Insertion de templates LaTeX
 * ============================================================ */

export function insertTexTemplate(ctx: SlashCtx, template: string): void {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  ctx.editor.focus();

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  range.deleteContents();
  const text = document.createTextNode(template);
  range.insertNode(text);

  // Trouve le span d'édition contenant le template pour limiter la recherche.
  const span = findActiveMathEdit(ctx.editor);
  if (span) {
    placeCaretAtFirstPlaceholder(span);
  } else {
    // Hors math-edit (cas dégradé) : caret après le texte.
    const r = document.createRange();
    r.setStartAfter(text);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  dispatchInput(ctx.editor);
}

/* ============================================================
 * Double-clic sur formule rendue : ré-ouvre l'édition
 * ============================================================ */

export function attachMathDoubleClick(editor: HTMLElement): () => void {
  const handler = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;
    const rendered = target.closest(
      ".math-inline, .math-block",
    ) as HTMLElement | null;
    if (!rendered) return;
    e.preventDefault();
    e.stopPropagation();
    reopenRenderedMath(editor, rendered);
  };
  editor.addEventListener("dblclick", handler);
  return () => editor.removeEventListener("dblclick", handler);
}

function reopenRenderedMath(editor: HTMLElement, rendered: HTMLElement): void {
  const display = rendered.getAttribute("data-display") === "true";
  const tex = rendered.getAttribute("data-tex") ?? "";
  const span = buildEditSpan(display, tex);

  if (display) {
    const wrap = wrapDisplay(span);
    // Si rendu est dans un .math-display, remplace le wrap entier.
    const target = rendered.parentElement?.classList.contains("math-display")
      ? rendered.parentElement
      : rendered;
    target.replaceWith(wrap);
  } else {
    rendered.replaceWith(span);
  }

  editor.focus();
  const sel = window.getSelection();
  const txt = span.firstChild as Text | null;
  if (sel && txt) {
    const r = document.createRange();
    r.setStart(txt, txt.data.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  dispatchInput(editor);
}

/* ============================================================
 * Tab : saute au prochain placeholder dans le span d'édition courant
 * ============================================================ */

export function handleMathTab(editor: HTMLElement): boolean {
  const span = findActiveMathEdit(editor);
  if (!span) return false;
  return jumpToNextPlaceholder(span);
}

/* ============================================================
 * Registre SLASH_MATH_COMMANDS
 * ============================================================ */

const P = MATH_PLACEHOLDER;

function tpl(template: string) {
  return (ctx: SlashCtx) => insertTexTemplate(ctx, template);
}

/** Atomes (juste insère le TeX brut, sans placeholders). */
function atom(s: string) {
  return tpl(s);
}

export const SLASH_MATH_COMMANDS: SlashCommand[] = [
  // ---------- Spéciales ----------
  {
    id: "math-exit",
    names: ["exit", "sortir", "close", "quitter", "fin"],
    label: "Sortir du bloc math",
    hint: "rend la formule",
    group: "math",
    run: exitMathEdit,
  },

  // ---------- Structures ----------
  { id: "frac", names: ["frac", "fraction"], label: "Fraction", hint: "\\frac{a}{b}", group: "math", run: tpl(`\\frac{${P}}{${P}}`) },
  { id: "sqrt", names: ["sqrt", "racine"], label: "Racine carrée", hint: "\\sqrt{x}", group: "math", run: tpl(`\\sqrt{${P}}`) },
  { id: "sqrtn", names: ["sqrtn", "racinen", "nrt"], label: "Racine n-ième", hint: "\\sqrt[n]{x}", group: "math", run: tpl(`\\sqrt[${P}]{${P}}`) },
  { id: "binom", names: ["binom", "binomial", "choose"], label: "Coefficient binomial", hint: "\\binom{n}{k}", group: "math", run: tpl(`\\binom{${P}}{${P}}`) },
  { id: "pow", names: ["pow", "exposant", "puissance"], label: "Exposant", hint: "^{n}", group: "math", run: tpl(`^{${P}}`) },
  { id: "exp", names: ["exp", "exponentielle", "exponential"], label: "Exponentielle", hint: "e^{x}", group: "math", run: tpl(`e^{${P}}`) },
  { id: "sub", names: ["sub", "indice"], label: "Indice", hint: "_{i}", group: "math", run: tpl(`_{${P}}`) },
  { id: "subsup", names: ["subsup", "ie"], label: "Indice + exposant", hint: "_{i}^{n}", group: "math", run: tpl(`_{${P}}^{${P}}`) },

  // ---------- Grands opérateurs ----------
  { id: "lim", names: ["lim", "limite"], label: "Limite", hint: "\\lim_{x \\to a}", group: "math", run: tpl(`\\lim_{${P} \\to ${P}} ${P}`) },
  { id: "sum", names: ["sum", "somme"], label: "Somme", hint: "\\sum_{i=0}^{n}", group: "math", run: tpl(`\\sum_{${P}=${P}}^{${P}} ${P}`) },
  { id: "prod", names: ["prod", "produit"], label: "Produit", hint: "\\prod_{i=0}^{n}", group: "math", run: tpl(`\\prod_{${P}=${P}}^{${P}} ${P}`) },
  { id: "int", names: ["int", "integrale", "integral"], label: "Intégrale", hint: "\\int_a^b f(x)\\,dx", group: "math", run: tpl(`\\int_{${P}}^{${P}} ${P} \\, d${P}`) },
  { id: "iint", names: ["iint", "double-int"], label: "Intégrale double", group: "math", run: atom(`\\iint `) },
  { id: "iiint", names: ["iiint", "triple-int"], label: "Intégrale triple", group: "math", run: atom(`\\iiint `) },
  { id: "oint", names: ["oint", "contour"], label: "Intégrale de contour", group: "math", run: atom(`\\oint `) },
  { id: "bigcup", names: ["bigcup"], label: "Grande union", group: "math", run: tpl(`\\bigcup_{${P}}^{${P}}`) },
  { id: "bigcap", names: ["bigcap"], label: "Grande intersection", group: "math", run: tpl(`\\bigcap_{${P}}^{${P}}`) },

  // ---------- Matrices / environnements ----------
  { id: "matrix", names: ["matrix", "matrice"], label: "Matrice (sans délim.)", group: "math", run: tpl(`\\begin{matrix} ${P} & ${P} \\\\ ${P} & ${P} \\end{matrix}`) },
  { id: "pmatrix", names: ["pmatrix", "parenthese"], label: "Matrice ( )", group: "math", run: tpl(`\\begin{pmatrix} ${P} & ${P} \\\\ ${P} & ${P} \\end{pmatrix}`) },
  { id: "bmatrix", names: ["bmatrix", "crochet"], label: "Matrice [ ]", group: "math", run: tpl(`\\begin{bmatrix} ${P} & ${P} \\\\ ${P} & ${P} \\end{bmatrix}`) },
  { id: "vmatrix", names: ["vmatrix", "determinant"], label: "Matrice | |", group: "math", run: tpl(`\\begin{vmatrix} ${P} & ${P} \\\\ ${P} & ${P} \\end{vmatrix}`) },
  { id: "Vmatrix", names: ["Vmatrix"], label: "Matrice ‖ ‖", group: "math", run: tpl(`\\begin{Vmatrix} ${P} & ${P} \\\\ ${P} & ${P} \\end{Vmatrix}`) },
  { id: "Bmatrix", names: ["Bmatrix", "accolade"], label: "Matrice { }", group: "math", run: tpl(`\\begin{Bmatrix} ${P} & ${P} \\\\ ${P} & ${P} \\end{Bmatrix}`) },
  { id: "cases", names: ["cases", "cas", "systeme"], label: "Cas (si … sinon)", group: "math", run: tpl(`\\begin{cases} ${P} & \\text{si } ${P} \\\\ ${P} & \\text{sinon} \\end{cases}`) },
  { id: "aligned", names: ["aligned", "align", "aligne"], label: "Lignes alignées", group: "math", run: tpl(`\\begin{aligned} ${P} &= ${P} \\\\ &= ${P} \\end{aligned}`) },

  // ---------- Relations ----------
  { id: "leq", names: ["leq", "le", "infeq"], label: "≤", group: "math", run: atom(`\\leq `) },
  { id: "geq", names: ["geq", "ge", "supeq"], label: "≥", group: "math", run: atom(`\\geq `) },
  { id: "neq", names: ["neq", "ne", "diff"], label: "≠", group: "math", run: atom(`\\neq `) },
  { id: "approx", names: ["approx", "env"], label: "≈", group: "math", run: atom(`\\approx `) },
  { id: "equiv", names: ["equiv", "eq3"], label: "≡", group: "math", run: atom(`\\equiv `) },
  { id: "sim", names: ["sim"], label: "∼", group: "math", run: atom(`\\sim `) },
  { id: "cong", names: ["cong"], label: "≅", group: "math", run: atom(`\\cong `) },
  { id: "propto", names: ["propto", "prop"], label: "∝ (proportionnel)", group: "math", run: atom(`\\propto `) },
  { id: "ll", names: ["ll"], label: "≪", group: "math", run: atom(`\\ll `) },
  { id: "gg", names: ["gg"], label: "≫", group: "math", run: atom(`\\gg `) },

  // ---------- Opérateurs binaires ----------
  { id: "pm", names: ["pm", "plusmoins"], label: "±", group: "math", run: atom(`\\pm `) },
  { id: "mp", names: ["mp", "moinsplus"], label: "∓", group: "math", run: atom(`\\mp `) },
  { id: "times", names: ["times", "fois", "x"], label: "× (fois)", group: "math", run: atom(`\\times `) },
  { id: "divop", names: ["divop", "divise"], label: "÷", group: "math", run: atom(`\\div `) },
  { id: "cdot", names: ["cdot", "point"], label: "⋅ (point centré)", group: "math", run: atom(`\\cdot `) },
  { id: "ast", names: ["ast", "asterisque"], label: "∗", group: "math", run: atom(`\\ast `) },
  { id: "star", names: ["star", "etoile"], label: "⋆", group: "math", run: atom(`\\star `) },
  { id: "oplus", names: ["oplus"], label: "⊕", group: "math", run: atom(`\\oplus `) },
  { id: "otimes", names: ["otimes"], label: "⊗", group: "math", run: atom(`\\otimes `) },
  { id: "ominus", names: ["ominus"], label: "⊖", group: "math", run: atom(`\\ominus `) },
  { id: "oslash", names: ["oslash"], label: "⊘", group: "math", run: atom(`\\oslash `) },

  // ---------- Ensembles ----------
  { id: "in", names: ["in", "appartient"], label: "∈", group: "math", run: atom(`\\in `) },
  { id: "notin", names: ["notin"], label: "∉", group: "math", run: atom(`\\notin `) },
  { id: "subset", names: ["subset"], label: "⊂", group: "math", run: atom(`\\subset `) },
  { id: "supset", names: ["supset"], label: "⊃", group: "math", run: atom(`\\supset `) },
  { id: "subseteq", names: ["subseteq"], label: "⊆", group: "math", run: atom(`\\subseteq `) },
  { id: "supseteq", names: ["supseteq"], label: "⊇", group: "math", run: atom(`\\supseteq `) },
  { id: "cap", names: ["cap", "intersection"], label: "∩", group: "math", run: atom(`\\cap `) },
  { id: "cup", names: ["cup", "union"], label: "∪", group: "math", run: atom(`\\cup `) },
  { id: "setminus", names: ["setminus", "moins"], label: "∖", group: "math", run: atom(`\\setminus `) },
  { id: "emptyset", names: ["emptyset", "vide"], label: "∅", group: "math", run: atom(`\\emptyset `) },
  { id: "N", names: ["N", "naturel", "nat"], label: "ℕ", group: "math", run: atom(`\\mathbb{N}`) },
  { id: "Z", names: ["Z", "relatif"], label: "ℤ", group: "math", run: atom(`\\mathbb{Z}`) },
  { id: "Q", names: ["Q", "rationnel"], label: "ℚ", group: "math", run: atom(`\\mathbb{Q}`) },
  { id: "R", names: ["R", "reel"], label: "ℝ", group: "math", run: atom(`\\mathbb{R}`) },
  { id: "C", names: ["C", "complexe"], label: "ℂ", group: "math", run: atom(`\\mathbb{C}`) },

  // ---------- Flèches ----------
  { id: "to", names: ["to", "vers"], label: "→", group: "math", run: atom(`\\to `) },
  { id: "gets", names: ["gets"], label: "←", group: "math", run: atom(`\\gets `) },
  { id: "mapsto", names: ["mapsto"], label: "↦", group: "math", run: atom(`\\mapsto `) },
  { id: "rightarrow", names: ["rightarrow", "droite"], label: "→", group: "math", run: atom(`\\rightarrow `) },
  { id: "Rightarrow", names: ["Rightarrow", "implique"], label: "⇒", group: "math", run: atom(`\\Rightarrow `) },
  { id: "leftarrow", names: ["leftarrow", "gauche"], label: "←", group: "math", run: atom(`\\leftarrow `) },
  { id: "Leftarrow", names: ["Leftarrow"], label: "⇐", group: "math", run: atom(`\\Leftarrow `) },
  { id: "leftrightarrow", names: ["leftrightarrow"], label: "↔", group: "math", run: atom(`\\leftrightarrow `) },
  { id: "Leftrightarrow", names: ["Leftrightarrow"], label: "⇔", group: "math", run: atom(`\\Leftrightarrow `) },
  { id: "iff", names: ["iff", "ssi", "equivaut"], label: "⇔ (ssi)", group: "math", run: atom(`\\iff `) },
  { id: "implies", names: ["implies"], label: "⟹", group: "math", run: atom(`\\implies `) },

  // ---------- Grecques minuscules ----------
  { id: "alpha", names: ["alpha"], label: "α", group: "math", run: atom(`\\alpha `) },
  { id: "beta", names: ["beta"], label: "β", group: "math", run: atom(`\\beta `) },
  { id: "gamma", names: ["gamma"], label: "γ", group: "math", run: atom(`\\gamma `) },
  { id: "delta", names: ["delta"], label: "δ", group: "math", run: atom(`\\delta `) },
  { id: "epsilon", names: ["epsilon"], label: "ε", group: "math", run: atom(`\\epsilon `) },
  { id: "varepsilon", names: ["varepsilon"], label: "ϵ (var)", group: "math", run: atom(`\\varepsilon `) },
  { id: "zeta", names: ["zeta"], label: "ζ", group: "math", run: atom(`\\zeta `) },
  { id: "eta", names: ["eta"], label: "η", group: "math", run: atom(`\\eta `) },
  { id: "theta", names: ["theta"], label: "θ", group: "math", run: atom(`\\theta `) },
  { id: "vartheta", names: ["vartheta"], label: "ϑ (var)", group: "math", run: atom(`\\vartheta `) },
  { id: "iota", names: ["iota"], label: "ι", group: "math", run: atom(`\\iota `) },
  { id: "kappa", names: ["kappa"], label: "κ", group: "math", run: atom(`\\kappa `) },
  { id: "lambda", names: ["lambda"], label: "λ", group: "math", run: atom(`\\lambda `) },
  { id: "mu", names: ["mu"], label: "μ", group: "math", run: atom(`\\mu `) },
  { id: "nu", names: ["nu"], label: "ν", group: "math", run: atom(`\\nu `) },
  { id: "xi", names: ["xi"], label: "ξ", group: "math", run: atom(`\\xi `) },
  { id: "pi", names: ["pi"], label: "π", group: "math", run: atom(`\\pi `) },
  { id: "varpi", names: ["varpi"], label: "ϖ (var)", group: "math", run: atom(`\\varpi `) },
  { id: "rho", names: ["rho"], label: "ρ", group: "math", run: atom(`\\rho `) },
  { id: "varrho", names: ["varrho"], label: "ϱ (var)", group: "math", run: atom(`\\varrho `) },
  { id: "sigma", names: ["sigma"], label: "σ", group: "math", run: atom(`\\sigma `) },
  { id: "varsigma", names: ["varsigma"], label: "ς (var)", group: "math", run: atom(`\\varsigma `) },
  { id: "tau", names: ["tau"], label: "τ", group: "math", run: atom(`\\tau `) },
  { id: "upsilon", names: ["upsilon"], label: "υ", group: "math", run: atom(`\\upsilon `) },
  { id: "phi", names: ["phi"], label: "φ", group: "math", run: atom(`\\phi `) },
  { id: "varphi", names: ["varphi"], label: "ϕ (var)", group: "math", run: atom(`\\varphi `) },
  { id: "chi", names: ["chi"], label: "χ", group: "math", run: atom(`\\chi `) },
  { id: "psi", names: ["psi"], label: "ψ", group: "math", run: atom(`\\psi `) },
  { id: "omega", names: ["omega"], label: "ω", group: "math", run: atom(`\\omega `) },

  // ---------- Grecques majuscules ----------
  { id: "Gamma", names: ["Gamma"], label: "Γ", group: "math", run: atom(`\\Gamma `) },
  { id: "Delta", names: ["Delta"], label: "Δ", group: "math", run: atom(`\\Delta `) },
  { id: "Theta", names: ["Theta"], label: "Θ", group: "math", run: atom(`\\Theta `) },
  { id: "Lambda", names: ["Lambda"], label: "Λ", group: "math", run: atom(`\\Lambda `) },
  { id: "Xi", names: ["Xi"], label: "Ξ", group: "math", run: atom(`\\Xi `) },
  { id: "Pi", names: ["Pi"], label: "Π", group: "math", run: atom(`\\Pi `) },
  { id: "Sigma", names: ["Sigma"], label: "Σ", group: "math", run: atom(`\\Sigma `) },
  { id: "Phi", names: ["Phi"], label: "Φ", group: "math", run: atom(`\\Phi `) },
  { id: "Psi", names: ["Psi"], label: "Ψ", group: "math", run: atom(`\\Psi `) },
  { id: "Omega", names: ["Omega"], label: "Ω", group: "math", run: atom(`\\Omega `) },

  // ---------- Fonctions standard ----------
  { id: "sin", names: ["sin"], label: "sin", group: "math", run: atom(`\\sin `) },
  { id: "cos", names: ["cos"], label: "cos", group: "math", run: atom(`\\cos `) },
  { id: "tan", names: ["tan"], label: "tan", group: "math", run: atom(`\\tan `) },
  { id: "cot", names: ["cot"], label: "cot", group: "math", run: atom(`\\cot `) },
  { id: "sec", names: ["sec"], label: "sec", group: "math", run: atom(`\\sec `) },
  { id: "csc", names: ["csc"], label: "csc", group: "math", run: atom(`\\csc `) },
  { id: "arcsin", names: ["arcsin"], label: "arcsin", group: "math", run: atom(`\\arcsin `) },
  { id: "arccos", names: ["arccos"], label: "arccos", group: "math", run: atom(`\\arccos `) },
  { id: "arctan", names: ["arctan"], label: "arctan", group: "math", run: atom(`\\arctan `) },
  { id: "sinh", names: ["sinh"], label: "sinh", group: "math", run: atom(`\\sinh `) },
  { id: "cosh", names: ["cosh"], label: "cosh", group: "math", run: atom(`\\cosh `) },
  { id: "tanh", names: ["tanh"], label: "tanh", group: "math", run: atom(`\\tanh `) },
  { id: "log", names: ["log"], label: "log", group: "math", run: atom(`\\log `) },
  { id: "ln", names: ["ln"], label: "ln", group: "math", run: atom(`\\ln `) },
  { id: "sup", names: ["sup"], label: "sup", group: "math", run: atom(`\\sup `) },
  { id: "inf", names: ["inf"], label: "inf", group: "math", run: atom(`\\inf `) },
  { id: "max", names: ["max"], label: "max", group: "math", run: atom(`\\max `) },
  { id: "min", names: ["min"], label: "min", group: "math", run: atom(`\\min `) },
  { id: "det", names: ["det"], label: "det", group: "math", run: atom(`\\det `) },
  { id: "gcd", names: ["gcd", "pgcd"], label: "gcd", group: "math", run: atom(`\\gcd `) },
  { id: "lcmm", names: ["lcm", "ppcm"], label: "lcm", group: "math", run: atom(`\\operatorname{lcm} `) },
  { id: "dim", names: ["dim"], label: "dim", group: "math", run: atom(`\\dim `) },
  { id: "ker", names: ["ker", "noyau"], label: "ker", group: "math", run: atom(`\\ker `) },
  { id: "Im", names: ["Im", "image"], label: "Im", group: "math", run: atom(`\\operatorname{Im} `) },
  { id: "Re", names: ["Re", "reelp"], label: "Re", group: "math", run: atom(`\\operatorname{Re} `) },

  // ---------- Accents ----------
  { id: "hat", names: ["hat", "chapeau"], label: "x̂", group: "math", run: tpl(`\\hat{${P}}`) },
  { id: "bar", names: ["bar", "barre"], label: "x̄", group: "math", run: tpl(`\\bar{${P}}`) },
  { id: "vec", names: ["vec", "vecteur"], label: "x⃗", group: "math", run: tpl(`\\vec{${P}}`) },
  { id: "tilde", names: ["tilde"], label: "x̃", group: "math", run: tpl(`\\tilde{${P}}`) },
  { id: "dotacc", names: ["dotacc", "pointacc"], label: "ẋ", group: "math", run: tpl(`\\dot{${P}}`) },
  { id: "ddot", names: ["ddot"], label: "ẍ", group: "math", run: tpl(`\\ddot{${P}}`) },
  { id: "widehat", names: ["widehat"], label: "x̂ large", group: "math", run: tpl(`\\widehat{${P}}`) },
  { id: "widetilde", names: ["widetilde"], label: "x̃ large", group: "math", run: tpl(`\\widetilde{${P}}`) },
  { id: "overline", names: ["overline"], label: "x̄ continu", group: "math", run: tpl(`\\overline{${P}}`) },
  { id: "underlinem", names: ["underlinem"], label: "x souligné", group: "math", run: tpl(`\\underline{${P}}`) },
  { id: "overrightarrow", names: ["overrightarrow", "fleche"], label: "x⃗ (flèche)", group: "math", run: tpl(`\\overrightarrow{${P}}`) },

  // ---------- Logique / quantificateurs ----------
  { id: "forall", names: ["forall", "quelque"], label: "∀", group: "math", run: atom(`\\forall `) },
  { id: "exists", names: ["exists", "existe"], label: "∃", group: "math", run: atom(`\\exists `) },
  { id: "nexists", names: ["nexists"], label: "∄", group: "math", run: atom(`\\nexists `) },
  { id: "neg", names: ["neg", "non"], label: "¬", group: "math", run: atom(`\\neg `) },
  { id: "land", names: ["land", "et"], label: "∧", group: "math", run: atom(`\\land `) },
  { id: "lor", names: ["lor", "ou"], label: "∨", group: "math", run: atom(`\\lor `) },
  { id: "infty", names: ["infty", "infini"], label: "∞", group: "math", run: atom(`\\infty `) },
  { id: "partial", names: ["partial", "partielle"], label: "∂", group: "math", run: atom(`\\partial `) },
  { id: "nabla", names: ["nabla"], label: "∇", group: "math", run: atom(`\\nabla `) },
  { id: "aleph", names: ["aleph"], label: "ℵ", group: "math", run: atom(`\\aleph `) },

  // ---------- Délimiteurs auto-taillés ----------
  { id: "abs", names: ["abs", "valeurabs"], label: "|x|", group: "math", run: tpl(`\\left|${P}\\right|`) },
  { id: "norm", names: ["norm", "norme"], label: "‖x‖", group: "math", run: tpl(`\\left\\|${P}\\right\\|`) },
  { id: "floor", names: ["floor", "plancher"], label: "⌊x⌋", group: "math", run: tpl(`\\left\\lfloor ${P} \\right\\rfloor`) },
  { id: "ceil", names: ["ceil", "plafond"], label: "⌈x⌉", group: "math", run: tpl(`\\left\\lceil ${P} \\right\\rceil`) },
  { id: "paren", names: ["paren", "parenthesem"], label: "( x )", group: "math", run: tpl(`\\left(${P}\\right)`) },
  { id: "brack", names: ["brack", "crochetm"], label: "[ x ]", group: "math", run: tpl(`\\left[${P}\\right]`) },
  { id: "brace", names: ["brace", "accoladem"], label: "{ x }", group: "math", run: tpl(`\\left\\{${P}\\right\\}`) },

  // ---------- Espacements ----------
  { id: "quad", names: ["quad"], label: "espace large", group: "math", run: atom(`\\quad `) },
  { id: "qquad", names: ["qquad"], label: "espace très large", group: "math", run: atom(`\\qquad `) },
  { id: "thinspace", names: ["space", "thin"], label: "espace fin", group: "math", run: atom(`\\, `) },

  // ---------- Texte dans math ----------
  { id: "textmath", names: ["text", "texte"], label: "Texte dans formule", hint: "\\text{…}", group: "math", run: tpl(`\\text{${P}}`) },
];
