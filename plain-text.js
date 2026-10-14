/**
 * Turn an answer into text a chat window actually shows.
 *
 * WeChat and WeCom render no markdown at all: `**bold**` arrives with the asterisks, `## heading` with the hashes,
 * and `$$x^2$$` with the dollars. The model writes markdown because the DSH client renders it, so everything that
 * leaves for a chat goes through here first.
 *
 * The rules are deliberately conservative: readability beats cleverness, and anything ambiguous is left alone. A
 * plain sentence must come out byte-for-byte identical - that is the property the tests pin down hardest, because a
 * sanitiser that quietly rewrites ordinary text is worse than no sanitiser at all.
 */

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

  // Math delimiters keep the formula and lose the dollars.
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, "$1");
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, "$1");
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, "$1");
  text = text.replace(/\$([^$\n]+)\$/g, "$1");

  // Private reasoning must never reach a chat, and neither must HTML.
  text = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Tables: separator rows go, cells become spaced text on their own line.
  // The separator row goes with its newline: leaving the line behind would open a gap inside the table.
  text = text.replace(/^[ \t]{0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*\n?/gm, "");
  text = text.replace(/^[ \t]{0,3}\|(.+)\|[ \t]*$/gm, (_, row) =>
    row.split("|").map((cell) => cell.trim()).filter(Boolean).join("  "));

  // Tidy up: no trailing spaces, never more than one blank line, no blank edges.
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
