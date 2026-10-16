# Turning a Word question bank into a Feishu bitable / 把一份 Word 题库变成飞书多维表格

**English abstract.** A 997-paragraph Chinese Word question bank (312 questions, no tables) was turned into a
structured Feishu bitable (285 questions after deduplication, 64 corrections), and then used as an answering
assistant inside the chat channels. This document records the whole pipeline — parsing, self-checks,
deduplication, fan-out fact-checking, upload, and field-by-field verification — plus the mistakes that cost time,
so the next run is faster. Every step is a short script; none of it needs a package the plugin does not already
have.

**一句话简介.** 一份 997 段、没有任何表格的中文 Word 题库（312 条），整理成了飞书多维表格（去重后 285 条、
修正 64 处），并且能在微信/飞书聊天里当答题助手。下面把整条流水线和踩过的坑都记下来。

---

## 1. 为什么值得走一遍

`feishu_bitable_*` / `feishu_sheet_*` / `feishu_doc_*` 这几个工具，只有配上"能结构化、能校验"的流程才有用。
一份人写的 Word 题库里同时存在：题型混排、答案藏在题干里、答案行带括注、题目重复、编号乱序、口径过时。
把它变成一张表，等于把"不可检索的文本"变成"可筛选、可协作、可回读校验的数据"。

这次的结果：**312 条 → 285 条**（删掉 27 条重复），**64 处修正**，上线后**逐字段比对 285/285 一致**，
答题正确率 100%（用户在竞赛里实测）。

---

## 2. 流水线总览

```
docx ──parse──▶ questions_raw.json ──clean──▶ 去重/编号
                                    │
                                    ├──review（多个 subagent 并行事实复核）──▶ decisions.json
                                    │
                                    └──finalize──▶ questions_final.json + .xlsx + 变更清单.md
                                                        │
                                                        └──upload──▶ 飞书多维表格 ──verify──▶ 逐字段 diff
```

每一步都落盘成文件，任何一步都可以重跑、可以复核、可以回滚。**不要一步到位**——一份 300 条的题库，
一次性生成的结果没法验证。

---

## 3. 解析：Word 里没有表格，靠的是结构

### 3.1 先看清结构，再写解析

```python
import docx
d = docx.Document(path)
print(len(d.paragraphs), len(d.tables))          # 997 0   ← 没有表格，全靠段落
for p in d.paragraphs[:40]:
    print(repr(p.text[:100]))
```

这份卷子的结构规律：

| 现象 | 处理 |
| --- | --- |
| 标题分段：`一、单选` `二、判断` `一、单选`（第二段）`二、多选` | 按标题切分状态机 |
| 单选题：`N. 题干（）` + 一行里 `\tA.x\tB.y\tC.z` | 用 `(?=[A-H][.、])` 拆选项 |
| 多选题：选项各占一行，偶尔 `C.xD.y` 挤在一行 | 同上，逐个 append |
| **判断题**：答案写在题干里 `…双重领导。（√）`，下一行是 `A.对B.错` | 抓 `（√/×）`，同时把 `（×，无军衔）` 里的说明抽成解析 |
| 答案行：`答案：\tB` 或 `答案：B（武警不属于解放军军种）` | 取字母，括注 → 「解析」列 |
| 简答区：题/答严格交替，答案有的带 `答：` 有的不带 | 见 3.3 |
| 第 861 段 `三`、`低/中/高` | 散落的难度标记，正好当成简答题的难度列 |

### 3.2 坑一：dump 出来的行号 ≠ 段落号

`"\n".join(p.text for p in paragraphs)` 会因为段落内部的 `<w:br/>`（软回车）多出几行，
于是"我看到的第 843 行"和"python-docx 的第 841 段"差 2。**排查问题时用带段落号的 dump**：

```python
lines = ["%d| %s" % (i + 1, d.paragraphs[i].text) for i in range(860, len(d.paragraphs))]
```

### 3.3 坑二：简答区不要用"问号结尾"判断新题

第一版用 `stripped.endswith("？")` 判断新题开场，结果这 3 道题以 **句号或括号** 结尾，被吞进上一题的答案里：

```
简述2035年、本世纪中叶国防军队建设目标。      ← 句号结尾
本人哪些行为会直接判定政考不合格？（至少说出5个）  ← 括号结尾
简述火箭军东风系列导弹主要作战分类            ← 什么都没有
```

正确做法是**用状态机**：这一区严格"题、答、题、答"交替，所以 **上一题是否已经拿到答案**才是判据：

```python
starts_new = cur is None or bool(cur["answer"])   # 已取到答案 ⇒ 这一行是新题
```

一行代码修好，简答从 59 条变成 65 条（多了 6 道被吞掉的题）。

### 3.4 解析完马上自检，别急着往下走

```python
problems = []
if not r["answer"]:                                    problems.append("NO_ANSWER")
if r["mode"] in ("单选", "多选"):
    if len(r["options"]) < 2:                          problems.append("FEW_OPTIONS")
    if any(a not in r["options"] for a in r["answer"]): problems.append("ANSWER_NOT_IN_OPTIONS")
```

这次自检一跑就抓到 1 条 `ANSWER_NOT_IN_OPTIONS`——那是解析 bug 的**症状**（简答区被并进多选题），
顺藤摸瓜才找到 3.3 的问题。**自检不是装饰，是定位工具。**

---

## 4. 去重：精确 + 近似，最后一律人工确认

```python
PUNCT = re.compile(r"[\s\u3000，,。.、；;：:！!？?（）()“”\"'《》【】—\-_/\\|~·…]+")
key = (mode, PUNCT.sub("", stem))          # 标点/空白无关的精确重复
```

近似重复用 `difflib.SequenceMatcher` 相似度 ≥ 0.7，或"短的包含在长的里"：

```python
ratio = difflib.SequenceMatcher(None, a, b).ratio()
contained = shorter in longer and len(shorter) >= 8
```

这次的结果：4 组精确重复 + 23 对近似候选，人工过一遍后**删 27 条、保留 4 组"近似但选项不同"的题**。
判断标准写成一句话：**题干同义 + 选项实质相同 → 删；只题干相近、选项不同 → 留**（不同的选项是不同的练习）。
保留的那些要写进变更清单，否则下次有人会再"去重"一次。

> 这份卷子的重复很有代表性：多选第 18–25 题整段重复了第 1–8 题，单选第一段和第二段也有 8 条重复，
> 还有"五大军种"、"烈士纪念日"这种同一考点换措辞再出一遍的。**同一份文件里自己跟自己重复**，很常见。

---

## 5. 事实复核：切片 + 并行 + 只回"非 ok"

300 条题目靠一个上下文逐条核对，既慢又容易糊。做法是**切成 6 片、并行派 6 个子代理**，每个子代理：

1. 读自己的切片（JSON，含题干、全部选项、答案、原解析）；
2. 逐条判定 `ok / suspect / wrong`，**只把非 ok 的写回文件**；
3. 每条必须给 `issue` + `fix` + `confidence`；
4. 涉法条、年份、数字、时政的才联网核实，其余凭常识——明确写"不要为了显得认真而滥报"。

6 片一共报回 25 条线索（7 wrong + 18 suspect）。**然后由主代理逐条裁定**，因为子代理也会错：

- ✅ 采信："战略支援部队已撤销"——附带国防部发布会链接，我自己再查一遍确认；
- ✅ 采信："体检标准里毒品检测属尿液检查"——查《应征公民体格检查标准》第五十四条原文；
- ⚖️ 部分采信："战斗力是检验军队一切工作的唯一根本标准"——答案取向没错，但用词过强，去掉"唯一"；
- ❌ 不采信：某些"建议改答案"其实是把权威口径和通俗表述混了——**改题干比改答案安全**。

**判据优先级：法律/官方原文 > 常识 > 子代理意见。** 每条改动都要在 `decisions.json` 里写 `reason`，
最后自动生成变更清单，用户能逐条回滚。

### 5.1 时政类是最危险的一类

这次抓到几道**看起来像真题、其实查无出处**的题：

| 原题 | 问题 | 处理 |
| --- | --- | --- |
| 2026 年国防动员建设新增统筹内容（无人机物流、网络平台运力征用…） | 完全编造 | 按 2026-10-01 施行的新修订《国防动员法》七项修改重写 |
| 2026 年国防预算增长资金主要投向（含"退役军人安置"） | 与官方口径不符 | 按国防部 2026-03-10 发布会的四个投向重写 |
| 体重超标哪些情况可酌情复检 | 标准里没有"酌情复检" | 改为 BMI 真实标准（男 17.5≤BMI<30、女 17≤BMI<24、BMI≥28 加查糖化血红蛋白） |
| 解放军五大军种 / 战略支援部队 | 2024 年 4 月军改后番号已撤销 | 改为"4 个军种 + 4 个兵种" |

**"绝对化措辞"是最好的探测器**：所有、一切、唯一、必须、都。判断题里出现这些词，十有八九表述过强：

- "战时**所有**企业必须优先保障军用物资生产" → 法条只约束承担军品任务的单位及其配套单位；
- "**一切**媒体都有义务开展国防宣传教育" → 法条对特定层级新闻媒体有明确要求；
- "**唯一**根本标准" → 权威提法是"唯一的根本的标准"，但被改写后就走样了。

改法永远是**把题干收到法条口径**，答案维持原判——这样既不丢分，也不留硬伤。

---

## 6. 写入飞书：默认字段只有 4 个，要自己扩

`feishu_bitable_create` 建出来的多维表格，默认表只有 **4 个字段**：`文本 / 单选 / 日期 / 附件`。
工具面只有 create / read / write，**没有建字段的接口**——所以字段得自己用 REST 扩（`tenant_access_token`
从插件的 `feishu.js` 拿，或者直接读面板里保存的凭据）：

```
GET    /open-apis/bitable/v1/apps/{app}/tables                      # 取 table_id
PUT    /open-apis/bitable/v1/apps/{app}/tables/{table}/fields/{fid}  # 改名（文本→题干、单选→题型）
DELETE /open-apis/bitable/v1/apps/{app}/tables/{table}/fields/{fid}  # 删掉用不上的日期/附件
POST   /open-apis/bitable/v1/apps/{app}/tables/{table}/fields        # 新建 编号/选项A-D/答案/解析/难度
POST   /open-apis/bitable/v1/apps/{app}/tables/{table}/records/batch_create   # 每批 100 条
```

最终字段：`编号 / 题型（单选） / 题干 / 选项A / 选项B / 选项C / 选项D / 答案 / 解析 / 难度（单选）`。

两个小细节：

- **单选的选项值不用预先登记**，写入时按字符串写就行（`题型: "多选"`）；
- **判分靠编号**：`单选001`、`多选055` 这种带题型前缀的编号，回读比对和人工核对都方便。

### 6.1 幂等：先清空，再写入

重跑上传脚本不该产生第二份数据。所以每次先 list 全部记录（`page_size=500` + `page_token` 翻页），
再 `records/batch_delete` 清空，然后重新写入：

```
rows to upload: 285
purge 0-500: 0 success          ← 第一次是 10 条测试数据，第二次是 285 条
purged existing records: 285
batch 0-99: ok, total 100
batch 100-199: ok, total 200
batch 200-284: ok, total 285
records now in table: 285
```

### 6.2 校验：只看"写入成功"是不够的

`batch_create` 返回 `code: 0` 只说明请求成功。真正的校验是**把线上数据拉回来，逐字段跟本地 diff**：

```
remote records: 285, local rows: 285
remote 题型分布: {"单选":84,"多选":99,"判断":43,"简答":59}
✅ 全部 285 条与本地数据逐字段一致
```

这个脚本还顺手抓过一次真问题：第一次写入后我又改了一批简答题，如果不重跑就会"表里是旧答案，
本地是新答案"。**改完必须重传 + 重校**，这一步不能省。

---

## 7. 变成聊天里的答题助手

数据进了多维表格之后，聊天侧不用写新代码：

- 微信/飞书里发一张题目的截图 → `feishu_*` / `browser_*` / 视觉工具读题，`feishu_bitable_read` 按编号取条目；
- 回答案时**带上编号和依据**（"题库对应条目：单选042 … 依据《领海及毗邻区法》第二条"），
  用户考完能顺着编号回去核对；
- 遇到**原卷答案与法条冲突**的题，两套都说：`考试选 A（原卷答案）` + `严格口径是……`，并说明整理版怎么改的。

用户实测：**满分 100**。其中至少 7 道题属于"原卷表述有硬伤、但答案方向没错"的情况——
这种时候**把答案和口径分开说**，比单纯"选 A" 有用得多。

---

## 8. 复用清单（脚本骨架）

| 文件 | 作用 |
| --- | --- |
| `parse_questions.py` | docx → `questions_raw.json` + 解析自检报告 |
| `clean_questions.py` | 精确去重、编号重排、重复组清单 |
| `find_near_dups.py` | 近似重复候选（相似度 / 包含关系） |
| `build_chunks.py` | 切片给并行复核用 |
| `decisions.json` | **唯一的人工决策文件**：删哪些行、改哪些字段、为什么 |
| `finalize.py` | 应用决策 → `questions_final.json` + xlsx + 变更清单.md |
| `feishu_setup.mjs` | 扩字段（改名/删除/新建） |
| `upload_feishu.mjs` | 清空 + 批量写入（幂等） |
| `verify_feishu.mjs` | 线上 vs 本地逐字段 diff |

一条经验：**把"人的决策"（decisions.json）和"机械的动作"（脚本）分开**。改主意只需要改 JSON 再跑一遍，
不需要重新解析 Word，也不需要重新问一遍子代理。

---

## 9. 结论：这五条最省时间

1. **先自检，再加工**：解析异常报告比任何"看起来对"的输出都可信。
2. **状态机 > 标点判断**：格式规律要用结构表达，别用"以问号结尾"这类脆弱的信号。
3. **并行复核 + 只回非 ok**：300 条题目，6 个子代理各报几条，主代理逐条对照原文裁定。
4. **法条原文 > 一切意见**：命中"所有/一切/唯一"的判断题，先去查法条，再决定改题干还是改答案。
5. **写完必须回读 diff**：`code: 0` 不是校验，逐字段比对才是。
