/**
 * Office documents: read, write and convert `.docx` / `.xlsx` / `.pptx` / PDF.
 *
 * Two external programs do the work, both already on this machine:
 *
 *   python  — bundled with the runtime, with `python-docx`, `openpyxl` and `python-pptx` (see PRESETS below)
 *   node + libreoffice-kit CLI — `convert` for PDF, `render` for page images
 *
 * Neither is embedded: this module builds an argument list and parses the answer, so the pure parts
 * (discovery, spec validation, script text) are testable without spawning anything, and a missing program
 * produces a sentence that says which one and where it looked - never a silent no-op.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

/** Extensions this module can read and write. */
export const OFFICE_KINDS = Object.freeze({ docx: "docx", xlsx: "xlsx", pptx: "pptx" });
/** Extensions it can convert *to*. */
export const CONVERT_TARGETS = Object.freeze(["pdf"]);

/** The kind implied by a path, or undefined. */
export function kindOf(path) {
  const ext = extname(String(path ?? "")).toLowerCase().replace(/^\./, "");
  return OFFICE_KINDS[ext];
}

/**
 * Validate the JSON spec for `office_write`.
 *
 * Returns `{ kind, spec }` or throws with a sentence naming the problem - the message is what the person in
 * the chat will read, so it says what to do, not only what is wrong.
 */
export function parseWriteSpec(path, jsonText) {
  const kind = kindOf(path);
  if (!kind) throw new Error(`路径要以 .docx / .xlsx / .pptx 结尾，收到 ${JSON.stringify(path)}`);
  let spec;
  try {
    spec = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
  } catch (error) {
    throw new Error(`内容不是合法 JSON：${String(error?.message ?? error)}`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("内容必须是一个 JSON 对象（不能是数组）");
  if (kind === "docx") {
    if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) throw new Error("docx 需要 blocks（段落 / 标题 / 表格组成的数组）");
  }
  if (kind === "xlsx") {
    if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) throw new Error("xlsx 需要 sheets（至少一个工作表）");
    for (const [index, sheet] of spec.sheets.entries()) {
      if (!sheet || !Array.isArray(sheet.rows)) throw new Error(`第 ${index + 1} 个工作表缺少 rows`);
    }
  }
  if (kind === "pptx") {
    if (!Array.isArray(spec.slides) || spec.slides.length === 0) throw new Error("pptx 需要 slides（至少一页）");
  }
  return { kind, spec };
}

/** The Python program, as text: one entry point for read and write so the two cannot drift. */
export const OFFICE_PY = String.raw`
import json, sys, os, base64

# Windows gives a piped stdout the locale code page (cp936 here), not UTF-8 - every Chinese cell came back
# as mojibake even though the document was correct. The answer is JSON, so pin the encoding.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(0)

# The payload arrives as base64 in argv rather than on stdin: a shell-free spawn needs no quoting rules,
# and base64 keeps any Unicode path or cell value intact through the command line.
if len(sys.argv) < 2:
    fail("没有收到 payload")
payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
action = payload.get("action")
path = payload.get("path")

def read_docx(p):
    from docx import Document
    doc = Document(p)
    blocks = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "") if para.style is not None else ""
        blocks.append({"type": "heading" if style.lower().startswith("heading") or style == "Title" else "paragraph", "style": style, "text": text})
    tables = []
    for table in doc.tables:
        rows = [[cell.text.strip() for cell in row.cells] for row in table.rows]
        tables.append(rows)
    return {"kind": "docx", "blocks": blocks, "tables": tables,
            "counts": {"paragraphs": len(doc.paragraphs), "tables": len(doc.tables)}}

def read_xlsx(p, max_rows=200):
    import openpyxl
    wb = openpyxl.load_workbook(p, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            if all(cell is None or str(cell).strip() == "" for cell in row):
                continue
            rows.append(["" if cell is None else str(cell) for cell in row])
            if len(rows) >= max_rows:
                break
        sheets.append({"name": ws.title, "rows": rows, "dims": ws.dimensions, "maxRow": ws.max_row, "maxColumn": ws.max_column})
    return {"kind": "xlsx", "sheets": sheets}

def read_pptx(p):
    from pptx import Presentation
    prs = Presentation(p)
    slides = []
    for index, slide in enumerate(prs.slides, 1):
        texts = []
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                texts.append(shape.text_frame.text.strip())
        slides.append({"index": index, "texts": texts})
    return {"kind": "pptx", "slides": slides, "counts": {"slides": len(prs.slides)}}

def write_docx(p, spec):
    from docx import Document
    from docx.shared import Pt
    doc = Document()
    if spec.get("title"):
        doc.add_heading(str(spec["title"]), level=0)
    for block in spec.get("blocks", []):
        kind = (block or {}).get("type", "paragraph")
        text = str((block or {}).get("text", ""))
        if kind == "heading":
            doc.add_heading(text, level=int((block or {}).get("level", 1)))
        elif kind == "bullets":
            for item in (block or {}).get("items", []):
                doc.add_paragraph(str(item), style="List Bullet")
        elif kind == "table":
            rows = (block or {}).get("rows", [])
            if not rows:
                continue
            width = max(len(r) for r in rows)
            table = doc.add_table(rows=len(rows), cols=width)
            table.style = "Table Grid"
            for r, row in enumerate(rows):
                for c in range(width):
                    cell = table.cell(r, c)
                    cell.text = str(row[c]) if c < len(row) else ""
                    if r == 0 and (block or {}).get("header", True):
                        for run in cell.paragraphs[0].runs:
                            run.bold = True
        else:
            doc.add_paragraph(text)
    directory = os.path.dirname(p)
    if directory:
        os.makedirs(directory, exist_ok=True)
    doc.save(p)
    return {"kind": "docx", "path": p, "bytes": os.path.getsize(p)}

def write_xlsx(p, spec):
    import openpyxl
    from openpyxl.styles import Font
    wb = openpyxl.Workbook()
    first = True
    for sheet in spec.get("sheets", []):
        ws = wb.active if first else wb.create_sheet()
        first = False
        ws.title = str(sheet.get("name") or f"Sheet{len(wb.worksheets)}")[:31]
        header = sheet.get("header", True)
        for row in sheet.get("rows", []):
            ws.append([cell for cell in row])
        if header and ws.max_row >= 1:
            for cell in ws[1]:
                cell.font = Font(bold=True)
        for index, width in enumerate(sheet.get("widths", []), start=1):
            if isinstance(width, (int, float)) and width > 0:
                ws.column_dimensions[openpyxl.utils.get_column_letter(index)].width = float(width)
    directory = os.path.dirname(p)
    if directory:
        os.makedirs(directory, exist_ok=True)
    wb.save(p)
    return {"kind": "xlsx", "path": p, "bytes": os.path.getsize(p)}

def write_pptx(p, spec):
    from pptx import Presentation
    from pptx.util import Pt
    prs = Presentation()
    for slide in spec.get("slides", []):
        title = str((slide or {}).get("title", ""))
        layout = prs.slide_layouts[1] if title else prs.slide_layouts[6]
        page = prs.slides.add_slide(layout)
        if title and page.shapes.title is not None:
            page.shapes.title.text = title
        body = [str(item) for item in (slide or {}).get("bullets", [])]
        if body:
            frame = None
            for shape in page.placeholders:
                if shape.placeholder_format.idx == 1:
                    frame = shape.text_frame
                    break
            if frame is None:
                box = page.shapes.add_textbox(0, 0, prs.slide_width, prs.slide_height)
                frame = box.text_frame
            frame.text = body[0]
            for line in body[1:]:
                frame.add_paragraph().text = line
    directory = os.path.dirname(p)
    if directory:
        os.makedirs(directory, exist_ok=True)
    prs.save(p)
    return {"kind": "pptx", "path": p, "bytes": os.path.getsize(p)}

try:
    if not path:
        fail("需要 path")
    if not os.path.exists(path) and action == "read":
        fail("文件不存在：" + path)
    if action == "read":
        kind = os.path.splitext(path)[1].lower().lstrip(".")
        if kind == "docx":
            result = read_docx(path)
        elif kind == "xlsx":
            result = read_xlsx(path, int(payload.get("maxRows") or 200))
        elif kind == "pptx":
            result = read_pptx(path)
        else:
            fail("只能读 .docx / .xlsx / .pptx，收到 " + kind)
    elif action == "write":
        kind = os.path.splitext(path)[1].lower().lstrip(".")
        spec = payload.get("spec") or {}
        if kind == "docx":
            result = write_docx(path, spec)
        elif kind == "xlsx":
            result = write_xlsx(path, spec)
        elif kind == "pptx":
            result = write_pptx(path, spec)
        else:
            fail("只能写 .docx / .xlsx / .pptx，收到 " + kind)
    else:
        fail("未知 action：" + str(action))
    result["ok"] = True
    print(json.dumps(result, ensure_ascii=False))
except Exception as error:
    fail(type(error).__name__ + ": " + str(error))
`;

/**
 * Where the two programs are. Every candidate is checked before it is offered, so `officeSupport()` can say
 * which one is missing instead of discovering it at call time.
 */
export function officeCandidates({ dshHome, resourcesPath, platform = process.platform } = {}) {
  const python = [];
  const kit = [];
  if (dshHome) {
    const runtimes = join(dshHome, "dsh-runtimes");
    try {
      for (const name of readdirSync(runtimes)) {
        python.push(join(runtimes, name, "dependencies", "python", platform === "win32" ? "python.exe" : "bin/python3"));
      }
    } catch {
      // No runtimes directory: the environment variables are the other way in.
    }
  }
  if (platform === "win32") python.push(join(homedir(), ".dsh", "dsh-runtimes"), "");
  // The kit lives inside the harness install, and "where that is" depends on how this process was started:
  // Electron exposes `process.resourcesPath`, a plain node process does not, and a portable unpack puts it
  // next to the executable. All three are tried, and the first that exists wins.
  const anchors = [resourcesPath, process.resourcesPath, join(dirname(process.execPath), "resources")].filter(Boolean);
  for (const anchor of anchors) {
    kit.push(join(anchor, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai", "libreoffice-kit", "lib", "cli.js"));
  }
  return {
    python: [...new Set(python.filter((p) => p && existsSync(p)))],
    kit: [...new Set(kit.filter((p) => p && existsSync(p)))],
  };
}

/** Resolve the toolchain, preferring an explicit setting over discovery. */
export function resolveToolchain({ prefs = {}, env = process.env, resourcesPath = process.resourcesPath, platform = process.platform } = {}) {
  const found = officeCandidates({ dshHome: env.DSH_HOME ?? join(homedir(), ".dsh"), resourcesPath, platform });
  const python = String(prefs.officePython ?? env.DSH_OFFICE_PYTHON ?? found.python[0] ?? "");
  const kit = String(prefs.officeKit ?? env.DSH_OFFICE_KIT ?? found.kit[0] ?? "");
  return {
    python: python || undefined,
    kit: kit || undefined,
    pythonCandidates: found.python,
    kitCandidates: found.kit,
    ready: Boolean(python && existsSync(python)),
    canConvert: Boolean(python && kit && existsSync(kit)),
  };
}

/**
 * Run the Python program with one JSON payload and parse its answer.
 *
 * `exec(command, args, options)` resolves to stdout - the same shape the plugin already uses for PowerShell,
 * so a test can inject a fake and the live path spawns a process without a shell.
 */
export async function runOffice({ python, payload, exec, timeoutMs = 120000 }) {
  if (!python) throw new Error("找不到 Python（设置 officePython 或环境变量 DSH_OFFICE_PYTHON）");
  if (typeof exec !== "function") throw new Error("内部错误：没有 exec");
  const encoded = Buffer.from(JSON.stringify(payload ?? {}), "utf8").toString("base64");
  const stdout = await exec(python, ["-c", OFFICE_PY, encoded], { timeoutMs });
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("Python 没有返回任何内容");
  let answer;
  try {
    answer = JSON.parse(text.split("\n").filter(Boolean).pop());
  } catch (error) {
    throw new Error(`Python 的输出不是 JSON：${text.slice(0, 200)}`);
  }
  if (answer?.ok === false) throw new Error(String(answer.error ?? "Office 操作失败"));
  return answer;
}

/** Where the LibreOffice Kit CLI keeps its entry point, given the toolchain result. */
export function kitArgs(kit, node) {
  if (!kit) throw new Error("找不到 LibreOffice Kit（设置 officeKit 或环境变量 DSH_OFFICE_KIT）");
  return { command: node, prefix: [kit] };
}

/** Convert an Office file to PDF. The source is read, never modified; the output goes to `output`. */
export async function convertOffice({ kit, node, input, output, exec, timeoutMs = 180000 }) {
  const { command, prefix } = kitArgs(kit, node);
  if (!String(output).toLowerCase().endsWith(".pdf")) throw new Error("目前只支持转成 PDF（output 要以 .pdf 结尾）");
  await exec(command, [...prefix, "convert", "--input", input, "--output", output], { timeoutMs });
  return { ok: true, input, output };
}

/** Render pages or a sheet range to PNGs; the CLI makes the output directory. */
export async function renderOffice({ kit, node, input, outputDir, pages, sheet, range, exec, timeoutMs = 180000 }) {
  const { command, prefix } = kitArgs(kit, node);
  const args = [...prefix, "render", "--input", input, "--output-dir", outputDir];
  if (pages) args.push("--pages", String(pages));
  if (sheet) args.push("--sheet", String(sheet));
  if (range) args.push("--range", String(range));
  const stdout = await exec(command, args, { timeoutMs });
  let manifest;
  try {
    manifest = JSON.parse(String(stdout ?? "").trim().split("\n").filter(Boolean).pop());
  } catch {
    manifest = { raw: String(stdout ?? "").slice(0, 400) };
  }
  return { ok: true, outputDir, manifest };
}

/** An absolute path, resolved against `cwd`, with the source file preserved by callers. */
export function absolutePath(path, cwd = process.cwd()) {
  const value = String(path ?? "").trim();
  if (!value) throw new Error("需要 path");
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}
