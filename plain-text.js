/**
 * Turn an answer into text a chat window actually shows.
 *
 * WeChat and WeCom render no markdown and no math: `**bold**` arrives with the asterisks, `## heading`
 * with the hashes, and `$$\frac{a}{b}$$` as a pile of dollars and backslashes. The model writes
 * markdown because the DSH client renders it, so everything that leaves for a chat goes through here.
 *
 * The rules are deliberately conservative: readability beats cleverness, and anything ambiguous is
 * left alone. A plain sentence must come out byte-for-byte identical - that is the property the tests
 * pin down hardest, because a sanitiser that quietly rewrites ordinary text is worse than no
 * sanitiser at all. LaTeX is only converted **inside math delimiters**, so a Windows path such as
 * `C:\Users\name` is never touched.
 */

/** Superscript and subscript characters for the digits, which cover most exponents people write. */
const SUPERSCRIPT = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUBSCRIPT = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", n: "ₙ", o: "ₒ", x: "ₓ" };

/** LaTeX commands whose meaning is a single character or a short word. */
const MATH_SYMBOLS = {
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "*",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", sim: "∼", propto: "∝",
  ll: "≪", gg: "≫", infty: "∞", partial: "∂", nabla: "∇", sum: "Σ", prod: "Π", int: "∫", oint: "∮",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔", mapsto: "↦",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", supset: "⊃", cup: "∪", cap: "∩", emptyset: "∅",
  forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨", therefore: "∴", because: "∵",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  degree: "°", circ: "°", ldots: "…", cdots: "…", dots: "…", quad: " ", qquad: "  ",
};

/** Markup commands that only wrap their content, which should survive. */
const MATH_WRAPPERS = ["text", "mathrm", "mathbf", "mathit", "operatorname", "mbox", "textrm"];

function superscript(body) {
  const chars = [...String(body)];
  if (chars.length > 0 && chars.every((c) => c in SUPERSCRIPT)) return chars.map((c) => SUPERSCRIPT[c]).join("");
  return `^(${body})`;
}

function subscript(body) {
  const chars = [...String(body)];
  if (chars.length > 0 && chars.every((c) => c in SUBSCRIPT)) return chars.map((c) => SUBSCRIPT[c]).join("");
  return `_(${body})`;
}

/**
 * Render a LaTeX expression as readable text.
 *
 * Best effort by design: a chat cannot show a formula, so the goal is something a person can follow
 * (`a/b`, `x²`, `√(x²+y²)`, `α + β × γ`) rather than typographic fidelity. Anything it does not know
 * keeps its name without the backslash, which is still easier to read than `\foo`.
 *
 * @param {unknown} input the math source, without its delimiters
 * @returns {string}
 */
export function mathToText(input) {
  let text = String(input ?? "");

  // Fractions, repeatedly, so `\frac{\frac{a}{b}}{c}` resolves.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(/\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_all, top, bottom) => {
      const numerator = /^[\w.]+$/.test(top.trim()) ? top.trim() : `(${top.trim()})`;
      const denominator = /^[\w.]+$/.test(bottom.trim()) ? bottom.trim() : `(${bottom.trim()})`;
      return `${numerator}/${denominator}`;
    });
    if (text === before) break;
  }

  // Roots: `\sqrt{x}` reads as √x, but a compound radicand needs brackets to stay unambiguous.
  text = text.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_all, index, body) => `${mathToText(index)}√(${body})`);
  text = text.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_all, body) => {
    const inner = body.trim();
    return /^[\w.]+$/.test(inner) ? `√${inner}` : `√(${inner})`;
  });

  // `\left(`/`\right)` and friends only exist to size the delimiters.
  text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg)\s*/g, "");

  // Wrapper commands: keep what they wrap.
  for (const wrapper of MATH_WRAPPERS) {
    text = text.replace(new RegExp(`\\\\${wrapper}\\s*\\{([^{}]*)\\}`, "g"), "$1");
  }

  // Exponents and indices, before the symbol pass so `^\circ` is not eaten by `^`.
  text = text.replace(/\^\s*\\circ\b/g, "°");
  text = text.replace(/\^\s*\{([^{}]*)\}/g, (_all, body) => superscript(body));
  // No parentheses in the single-character rule: `^(` is part of the fallback this file just wrote.
  text = text.replace(/\^([0-9+\-=ni])/g, (_all, body) => SUPERSCRIPT[body] ?? `^${body}`);
  text = text.replace(/_\s*\{([^{}]*)\}/g, (_all, body) => subscript(body));
  text = text.replace(/_([0-9+\-=aeijnox])/g, (_all, body) => SUBSCRIPT[body] ?? `_${body}`);

  // Command names, longest first so `\leq` is not read as `\le` plus `q`.
  const names = Object.keys(MATH_SYMBOLS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    text = text.replace(new RegExp(`\\\\${name}\\b`, "g"), MATH_SYMBOLS[name]);
  }
  text = text.replace(/\\[,;:!> ]/g, " ").replace(/\\%/g, "%").replace(/\\([{}])/g, "$1");
  // An unknown command keeps its name, which is friendlier than a stray backslash.
  text = text.replace(/\\([a-zA-Z]+)/g, "$1");

  return text.replace(/\s{2,}/g, " ").trim();
}

/** A link's label and target, as a chat can show them. */
function readableLink(label, target) {
  const text = String(label ?? "").trim();
  const url = String(target ?? "").trim();
  if (!url) return text;
  if (!text || text === url) return url;
  return `${text}（${url}）`;
}

/**
 * @param {unknown} input the text as the model wrote it
 * @returns {string} the same text with the markup a chat cannot render taken out
 */
export function toPlainText(input) {
  let text = String(input ?? "");
  if (!text) return "";

  // Fenced code: keep the code, drop the fence and its language tag.
  text = text.replace(/^[ \t]{0,3}```[^\n]*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm, "$1");
  text = text.replace(/^[ \t]{0,3}~~~[^\n]*\n([\s\S]*?)^[ \t]{0,3}~~~[ \t]*$/gm, "$1");
  // An unterminated fence (a turn cut short) still loses the fence line.
  text = text.replace(/^[ \t]{0,3}(```|~~~)[^\n]*$/gm, "");

  // Inline code keeps its content.
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Images are noise in a chat; their alt text is usually not even a description.
  text = text.replace(/!\[[^\]]*\]\([^)\s]*\)/g, "");
  // Links become "label（url）", the way people paste them.
  text = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label, target) => readableLink(label, target));

  // Headings: the words stay, the hashes go. Setext underlines go entirely.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}(={3,}|-{3,})[ \t]*$/gm, "");
  // Horizontal rules are punctuation that renders as a line of dashes; drop the line.
  text = text.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");

  // Block quotes lose the marker, keep the sentence.
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");

  // Bullets become a middot; numbered lists already read correctly and keep their numbers.
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1· ");

  // Emphasis. Bold first, so `**x**` is not half-eaten by the italic rule.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  text = text.replace(/__([^_\n]+)__/g, "$1");
  text = text.replace(/(^|[\s(（[「])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=$|[\s)）\]」,，.。;；:：!！?？])/gm, "$1$2");
  text = text.replace(/(^|[\s(（[「])_(?!\s)([^_\n]+?)(?<!\s)_(?=$|[\s)）\]」,，.。;；:：!！?？])/gm, "$1$2");
  // Whatever emphasis markers survived (a span split across a cut-off answer) must not reach the chat.
  text = text.replace(/\*{2,}/g, "").replace(/(?<=\s)_{2,}(?=\s)/g, "");

  // Math: the delimiters go and the expression becomes readable text. Only inside the delimiters,
  // so a path like C:\Users\name is never interpreted as LaTeX.
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_all, body) => mathToText(body));
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_all, body) => mathToText(body));
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_all, body) => mathToText(body));
  text = text.replace(/\$([^$\n]+)\$/g, (_all, body) => mathToText(body));

  // Private reasoning must never reach a chat, and neither must HTML.
  text = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Tables. The separator row goes with its newline (leaving it behind would open a gap inside the
  // table), and a two-column row reads as a labelled line rather than two words side by side.
  text = text.replace(/^[ \t]{0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*\n?/gm, "");
  text = text.replace(/^[ \t]{0,3}\|(.+)\|[ \t]*$/gm, (_all, row) => {
    const cells = row.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
    if (cells.length === 0) return "";
    if (cells.length === 2) return `· ${cells[0]}：${cells[1]}`;
    return `· ${cells.join("  ")}`;
  });

  // Tidy up: no trailing spaces, never more than one blank line, no blank edges.
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
