"""把 docs/deploy.md 转成 Word（再由 LibreOffice 转 PDF）。

只用 python-docx：标题层级、正文、无序列表、代码块（等宽 + 灰底）、表格、引用（> 开头）。
不做完整 Markdown 解析 —— 这份文档用到的语法就这些，够了；遇到没处理的行按正文输出，不会丢内容。
"""
import re
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

CJK = "Microsoft YaHei"
MONO = "Consolas"


def shade(paragraph, hex_color="F2F2F2"):
    """给段落加背景色（代码块用）。"""
    pPr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    pPr.append(shd)


def set_cjk(run, name=CJK):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)


def add_inline_code(paragraph, text):
    """处理行内的 `code` 与 **粗体**。

    第一版只处理 `code`，于是 `**粗体**` 的星号原样印在 PDF 上（表格里尤其难看）。
    现在按标记切开，逐段设置格式；`**` 与反引号可以嵌套（粗体里的代码段取粗体+等宽）。
    """
    # [文字](地址) → 文字（PDF 里链接点不动，原样印出来只是噪音）
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    for chunk in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if not chunk:
            continue
        bold = False
        body = chunk
        if chunk.startswith("**") and chunk.endswith("**") and len(chunk) > 4:
            bold = True
            body = chunk[2:-2]
        # 粗体里可能还有 `code`
        for piece in re.split(r"(`[^`]+`)", body):
            if not piece:
                continue
            if piece.startswith("`") and piece.endswith("`") and len(piece) > 2:
                run = paragraph.add_run(piece[1:-1])
                run.font.name = MONO
                run.font.size = Pt(9.5)
                run.font.color.rgb = RGBColor(0x9C, 0x27, 0x00)
            else:
                run = paragraph.add_run(piece)
                set_cjk(run)
            if bold:
                run.font.bold = True


def flush_table(doc, rows):
    """把收集到的 | 行做成表格；第一行当表头。"""
    cells = [[c.strip() for c in row.strip().strip("|").split("|")] for row in rows]
    if not cells:
        return
    # 去掉 |---| 分隔行
    cells = [row for row in cells if not all(re.fullmatch(r":?-{2,}:?", c or "-") for c in row)]
    if not cells:
        return
    width = max(len(row) for row in cells)
    table = doc.add_table(rows=len(cells), cols=width)
    table.style = "Light Grid Accent 1"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for r, row in enumerate(cells):
        for c in range(width):
            cell = table.cell(r, c)
            cell.text = ""
            paragraph = cell.paragraphs[0]
            add_inline_code(paragraph, row[c] if c < len(row) else "")
            for run in paragraph.runs:
                run.font.size = Pt(9)
                if r == 0:
                    run.font.bold = True
    doc.add_paragraph()


def convert(md_path, docx_path):
    lines = open(md_path, encoding="utf-8").read().split("\n")
    doc = Document()

    # 页面与默认字体
    section = doc.sections[0]
    section.left_margin = section.right_margin = Inches(0.8)
    section.top_margin = section.bottom_margin = Inches(0.7)
    normal = doc.styles["Normal"]
    normal.font.size = Pt(10.5)
    normal.font.name = CJK
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), CJK)

    in_code = False
    table_rows = []
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()

        # 代码块
        if re.match(r"^\s*```", line):
            if in_code:
                in_code = False
                doc.add_paragraph()
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.space_after = Pt(0)
            paragraph.paragraph_format.space_before = Pt(0)
            paragraph.paragraph_format.left_indent = Inches(0.15)
            run = paragraph.add_run(raw if raw.strip() else " ")
            run.font.name = MONO
            run.font.size = Pt(9)
            shade(paragraph)
            i += 1
            continue

        # 表格
        if line.strip().startswith("|"):
            table_rows.append(line)
            i += 1
            continue
        if table_rows:
            flush_table(doc, table_rows)
            table_rows = []

        if not line.strip():
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            heading = doc.add_heading(level=min(level, 4))
            run = heading.add_run(re.sub(r"[*`]", "", m.group(2)))
            set_cjk(run)
            i += 1
            continue

        # 分隔线
        if re.fullmatch(r"-{3,}", line.strip()):
            doc.add_paragraph()
            i += 1
            continue

        # 无序列表（两空格缩进的当二级）
        m = re.match(r"^(\s*)-\s+(.*)$", line)
        if m:
            indent = 1 if len(m.group(1)) >= 2 else 0
            paragraph = doc.add_paragraph(style="List Bullet" if indent == 0 else "List Bullet 2")
            add_inline_code(paragraph, m.group(2))
            i += 1
            continue

        # 引用（> 开头）
        if line.startswith(">"):
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Inches(0.3)
            run = paragraph.add_run(line.lstrip("> ").strip())
            run.italic = True
            set_cjk(run)
            i += 1
            continue

        # 普通段落（连续的合并）
        paragraph = doc.add_paragraph()
        add_inline_code(paragraph, line)
        i += 1

    if table_rows:
        flush_table(doc, table_rows)

    doc.save(docx_path)
    return docx_path


if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2]
    print("生成", convert(src, dst))
