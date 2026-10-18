/**
 * Keep `agent-default-model` alive in the DSH profile patch.
 *
 * Twice now that block vanished - once on 2026-10-17, once on 2026-10-18 after a crash - and the symptom was not a
 * broken config file but a chat that answered `no API key for provider route "deepseek-official"`: without the block the
 * default route needs `DEEPSEEK_API_KEY`, while the account provider needs only the stored login. So there are two
 * defences here:
 *
 *  1. the plugin's own sessions remember the last provider/model that worked, and use it when the default is gone;
 *  2. the file is repaired at startup, so the *next* run - including the main chat - has the block again.
 *
 * Repairing cannot help the run it happens in: the loader has already read the file. That is why (1) exists.
 */

/** The patch entry id DSH's loader targets. */
export const MODEL_BLOCK_ID = "agent-default-model";

/** Where the block goes when the file is empty or starts with `[]`. */
const HEADER = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
];

/** A selection is a provider plus a model; anything else is not usable. */
export function isSelection(value) {
  return Boolean(value && typeof value.provider === "string" && value.provider.trim()
    && typeof value.model === "string" && value.model.trim());
}

/** Normalise whatever the host hands us into `{provider, model, reasoningEffort?}` or null. */
export function selectionOf(value) {
  if (!isSelection(value)) return null;
  const out = { provider: value.provider.trim(), model: value.model.trim() };
  if (typeof value.reasoningEffort === "string" && value.reasoningEffort.trim()) out.reasoningEffort = value.reasoningEffort.trim();
  return out;
}

/**
 * Choose what to use for a session: what the host offers, else what last worked.
 *
 * "What last worked" is the important half: it is the only thing that still knows the answer when the config block has
 * been deleted, which is exactly the case this module exists for.
 */
export function pickSelection(current, remembered) {
  const live = selectionOf(current);
  if (live) return { selection: live, source: "current" };
  const last = selectionOf(remembered);
  if (last) return { selection: last, source: "remembered" };
  return { selection: null, source: "none" };
}

/** Does the patch text already carry the block? Matched by id, not by formatting. */
export function hasModelBlock(text) {
  return new RegExp(`^-\\s*id:\\s*${MODEL_BLOCK_ID}\\s*$`, "m").test(String(text ?? ""))
    || new RegExp(`^-\\s*id:\\s*["']${MODEL_BLOCK_ID}["']\\s*$`, "m").test(String(text ?? ""));
}

/** The block itself, indented the way a top-level loader entry is. */
export function modelBlock({ provider, model, reasoningEffort } = {}) {
  const selection = selectionOf({ provider, model, reasoningEffort });
  if (!selection) throw new Error("a model block needs a provider and a model");
  const lines = [
    `- id: ${MODEL_BLOCK_ID}`,
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    "    # Written by dsh-wechat-media: without this block the default route is `deepseek-official`, which needs",
    "    # DEEPSEEK_API_KEY. The account provider authenticates with the stored login, so chats work without one.",
    `    provider: ${selection.provider}`,
    `    model: ${selection.model}`,
  ];
  if (selection.reasoningEffort) lines.push(`    reasoningEffort: ${selection.reasoningEffort}`);
  return lines.join("\n");
}

/**
 * Insert the block into a patch file, preserving everything else.
 *
 * The file is a top-level YAML array, so the block goes **before the first entry** - after any leading comments - or at
 * the end when there is no entry yet. An empty file or a bare `[]` becomes a real array with the block in it.
 */
export function insertModelBlock(text, selection) {
  const block = modelBlock(selection);
  // A byte-order mark is legal UTF-8 but some YAML readers reject it, and PowerShell writes one by default - which is
  // exactly how it got into this file once already. Writing it back cleaned is the one chance to get rid of it.
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  if (hasModelBlock(source)) return source;
  const lines = source.split(/\r?\n/);
  const body = lines.filter((line) => line.trim() !== "" && line.trim() !== "[]");
  const firstEntry = body.findIndex((line) => /^-(\s|$)/.test(line));
  if (firstEntry === -1) {
    const kept = body.filter((line) => line.trim().startsWith("#"));
    const head = kept.length ? kept : HEADER;
    return `${head.join("\n")}\n${block}\n`;
  }
  const insertAt = lines.indexOf(body[firstEntry]);
  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(insertAt).join("\n");
  return `${before}${before.endsWith("\n") || before === "" ? "" : "\n"}${block}\n${after}`;
}
