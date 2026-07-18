# SnapCraft AI「文档导出」功能深度审计报告

> 审计范围：snap-craft 项目 AI 助手的 6 种格式导出（MD/TXT/HTML/DOCX/PPTX/XLSX）+ PDF + ZIP
> 审计基线：纯前端、零 Rust 导出逻辑（Rust 侧仅 `save_text_file` / `save_binary_file` / `reveal_in_folder` / `open_path` 四个薄命令）
> 审计人：audit-export（software-docgen-review 团队）
> 审计日期：2026-07-18
> thoroughness：very thorough

---

## 一、审计结论概览

整体结论：**导出功能主体真实可用，非空壳**。6 种格式均有真实落盘逻辑（PDF 除外，走系统打印），截图内嵌在 DOCX/HTML/PPTX/PDF 四种产物中均真实生效。但存在 **1 个假实现（XLSX 表头样式）**、**1 个格式错乱（PPTX JPEG 截图命名）**、**1 个主题映射缺陷（PPTX 主题色与 UI 5 套主题不一致）**、**1 个设计局限（PDF 不落盘）**，以及若干 UX 与健壮性改进点。

team-lead 线索核实：
- `markdownPptx.ts:658` 注释「导致每份导出文件在 PowerPoint 文件信息里都显示错的时间与标题（典型假实现）」——**已修复**，当前 `coreXml()` 已写入真实标题 + 导出时刻 ISO（line 660-670, 814），非当前 bug，属历史修复记录。
- `SNAP:k → sectionImages[parseInt(k)-1]` off-by-one——**经核实无 bug**。DOCX/HTML/PPTX 三处均用 `parseInt(marker[1], 10) - 1`（1 基标记 → 0 基数组），且三处实现一致。

---

## 二、问题清单（按严重度排序）

### P0-1 [假实现] XLSX 表头加粗 + 底色被静默丢弃

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownXlsx.ts:114` |
| 现象 | 代码设置 `ws[addr].s = { font: { bold: true }, fill: { fgColor: 'EEF2FF' } }`，但导出的 `.xlsx` 文件中表头既不加粗也无底色。 |
| 根因 | 项目依赖 `xlsx: ^0.18.5`（SheetJS 社区版，见 `package.json:27`）。社区版的 `XLSX.write()` **不序列化单元格 `.s` 样式属性**——这是 SheetJS Pro 专属能力。`XLSX.write(wb, { type: 'array', bookType: 'xlsx' })`（line 152）未传 `cellStyles: true`，且即便传入也只影响读取、不影响写入。代码设置的样式被静默丢弃，导出的 xlsx 表头与数据行视觉无差异。 |
| 代码片段 | ```ws[addr].s = { font: { bold: true }, fill: { fgColor: 'EEF2FF' } };``` |
| 建议 | 二选一：(a) 移除样式代码 + 注释说明社区版不支持，避免「看起来在加粗」的假实现；(b) 换用 `exceljs`（支持样式写入）或在社区版基础上手搓 `xl/styles.xml` 注入样式。列宽自适应（`!cols`）是社区版真实支持的，可保留。 |

### P0-2 [格式错乱] PPTX 截图始终命名 `.png`，JPEG 截图产出非法 OOXML

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownPptx.ts:769, 785, 716` |
| 现象 | 无论截图实际是 PNG 还是 JPEG，media 文件名恒为 `image${n}.png`（line 769, 785），且 `[Content_Types].xml` 只声明 `<Default Extension="png" ContentType="image/png"/>`（line 716），无 `jpeg`/`jpg` 默认类型。 |
| 根因 | `base64ToBytes()`（line 138-144）只解码 base64，不检测实际格式；`dataUrlDims()`（line 147-180）虽能识别 PNG/JPEG 魔数字节，但检测结果仅用于尺寸、未回传格式给命名逻辑。若截图 dataUrl 为 `data:image/jpeg;base64,...`（部分系统截图工具默认 JPEG），bytes 是 JPEG 但扩展名/Content-Type 标为 PNG → PowerPoint 严格模式下可能报「文件已损坏」或图片不显示。 |
| 代码片段 | ```mediaName = `image${mediaCounter}.png`;```（line 769） |
| 建议 | 从 dataUrl 头解析 MIME，按实际格式命名 `imageN.png`/`imageN.jpeg`，并在 `buildContentTypes` 中补充 `<Default Extension="jpeg" ContentType="image/jpeg"/>`。PowerPoint 对格式嗅探较宽容，但 Keynote/WPS 可能更严格。 |

### P1-1 [设计局限] PDF 导出不落盘，依赖用户手动「存储为 PDF」

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/AIPanel.tsx:1047-1081`（`handleExportPdf`）；`AIPanel.tsx:38-94`（`printHtmlViaIframe`） |
| 现象 | PDF 导出通过隐藏 iframe 调用 `window.print()`，由用户在系统打印弹窗中手动选择「存储为 PDF」。应用拿不到最终文件路径，不写 `lastExportedPath`，故无「在 Finder 中显示」/「打开文件」按钮。 |
| 根因 | 纯前端无法直接生成 PDF 二进制（无 jsPDF/pdfmake 依赖），走系统打印是零依赖的折中。代码诚实提示 `exportPdfHint`（「已调起系统打印，请在弹窗中选择「存储为 PDF」保存」），非假实现，但与其他 5 种格式的「一键落盘 + Finder 定位」体验落差明显。 |
| 影响 | 用户若误选真实打印机，不会得到 PDF 文件；无法批量自动导出 PDF；PDF 是唯一无「打开文件」按钮的格式。 |
| 建议 | 如需真落盘，可引入 `pdf-lib` 或 `jsPDF` + `html2canvas`（但会显著增大包体积），或在 Rust 侧用 `printpdf` crate 生成。当前折中方案可保留，但建议在 UI 上更明显地标注「打印式导出」。 |

### P1-2 [缺陷] PPTX 主题色与 UI 5 套主题不一致，3 套主题静默回退

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownPptx.ts:12-19` vs `src/features/ai/markdownHtml.ts:22-48` |
| 现象 | UI 提供 5 套文档主题（`modern`/`elegant`/`magazine`/`product`/`tech`，见 `markdownHtml.ts:22-48` 与 `AIPanel.tsx:1641`）。DOCX 的 `THEME_ACCENT`（`markdownDocx.ts:63-69`）正确映射全部 5 套；但 PPTX 的 `THEME_ACCENT`（`markdownPptx.ts:12-19`）用的是另一套 key：`modern`/`classic`/`elegant`/`sunset`/`forest`/`rose`，且类型为 `Record<string, string>`（无类型约束）。 |
| 根因 | PPTX 主题表与 DOCX/HTML 主题表不同源、未对齐。映射结果：<br>- `modern` → `2563EB`（PPTX）vs `4F46E5`（DOCX）——颜色不同<br>- `elegant` → `7C3AED`（PPTX 紫）vs `8B6F4E`（DOCX 暖棕）——完全不同<br>- `magazine` → **undefined** → 回退 `modern` `2563EB`<br>- `product` → **undefined** → 回退 `modern`<br>- `tech` → **undefined** → 回退 `modern`<br>PPTX 还定义了 `classic`/`sunset`/`forest`/`rose` 四个 UI 从未暴露的 key。 |
| 代码片段 | ```const THEME_ACCENT: Record<string, string> = { modern: '2563EB', classic: '1F4E79', elegant: '7C3AED', ... };```（line 12）<br>```const accent = THEME_ACCENT[opts.theme ?? 'modern'] ?? THEME_ACCENT.modern;```（line 729） |
| 建议 | 把 PPTX `THEME_ACCENT` 改为 `Record<DocThemeId, string>` 并与 DOCX 对齐颜色值（或至少同 key 同色），删除 UI 不可选的 `classic`/`sunset`/`forest`/`rose`。当前用户选「杂志风」导出 PPTX 得到的是蓝色标题，与 HTML/DOCX 导出的珊瑚色不一致。 |

### P1-3 [健壮性] DOCX 图片类型映射将 WebP/SVG 错标为 PNG

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownDocx.ts:226-235` |
| 现象 | `typeMap` 把 `image/webp` 和 `image/svg+xml` 都映射为 `'png'` 类型。若截图为 WebP/SVG，字节是 WebP/SVG 但 docx `ImageRun` 的 `type` 标为 PNG，Word 会按 PNG 解码失败 → 图片不显示或报错。 |
| 根因 | docx 库的 `ImageRun` 支持类型仅 `png/jpg/gif/bmp`，不支持 WebP/SVG。代码用 `png` 兜底而非拒绝或转码。 |
| 代码片段 | ```'image/webp': 'png', 'image/svg+xml': 'png',```（line 232-233） |
| 建议 | Tauri 截图默认 PNG，实际触发概率低。但若用户粘贴 WebP 截图，应要么转码为 PNG（Canvas 重绘）、要么跳过该图并提示。当前静默错标可能导致 Word 弹「无法显示链接的图片」。 |

### P2-1 [UX] MD/TXT/HTML/PDF 导出无 loading 态，按钮无反馈

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/AIPanel.tsx:888-931`（`handleExport`）、`1047-1081`（`handleExportPdf`） |
| 现象 | `handleExportDocx/Pptx/Xlsx` 均有 `setExporting(true/false)` + `finally` 重置 + 按钮显示「导出中…」。但 `handleExport`（md/txt/html）和 `handleExportPdf` **不设置 `exporting`**，按钮恒显原始文字，用户无反馈。 |
| 根因 | `handleExport` 只做 `if (!output || exporting) return;` 守卫，但自身不翻转 `exporting`。PDF 同理——打印弹窗可能停留很久，按钮却看起来可点击。 |
| 影响 | 大 HTML（含 base64 截图）写入期间无反馈；PDF 打印期间用户可重复点击触发多个打印 iframe 堆叠。 |
| 建议 | 给 `handleExport` 和 `handleExportPdf` 补 `setExporting(true)` + `finally`，并在 PDF 按钮上显示「导出中…」态。 |

### P2-2 [UX] 历史库导出无 loading/禁用态，可重复点击

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/AIPanel.tsx:430-548`（`handleHistoryExport`） |
| 现象 | 历史库导出按钮（line 2274-2309）无 `disabled` 属性，`handleHistoryExport` 不调用任何 loading 状态 setter。用户可在导出进行中重复点击，触发多个 `pickExportPath` 弹窗叠加。 |
| 根因 | 历史库导出复用了主面板的 handler 逻辑但未接入 `exporting` 状态机。 |
| 建议 | 为历史库导出单独加一个 `historyExporting` 状态，或在 `handleHistoryExport` 入口加 `if (historyExporting) return;` 守卫并禁用按钮。 |

### P2-3 [一致性] PPTX 只按 H1/H2 断页，H3-H6 降级为正文

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownPptx.ts:229` |
| 现象 | `parseSlides` 用 `/^(#{1,2})\s+(.*)$/` 断页，H3-H6 不产生新幻灯片，作为正文文本渲染。若文档仅含 H3+ 标题，会合并为单张幻灯片。 |
| 根因 | 设计取舍（MVP 注释 line 6-7 说明按 #/## 断页）。但 DOCX/HTML 支持 H1-H6 全级别，PPTX 与之不对齐。 |
| 建议 | 可接受的设计取舍，但建议在 UI 或文档中说明 PPTX 按 H1/H2 断页，避免用户预期 H3 也成页。 |

### P3-1 [小问题] PPTX core.xml 未写入 subtitle/description

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownPptx.ts:660-670` |
| 现象 | `coreXml(title, nowIso)` 只写 `dc:title`/`dc:creator`/`cp:lastModifiedBy`/`dcterms:created`/`dcterms:modified`，未写 `dc:description`。而 DOCX（`markdownDocx.ts:621`）把 `opts.subtitle` 写入 `description`。 |
| 根因 | PPTX 的 `MarkdownToPptxOptions` 有 `subtitle` 字段（line 23），但 `coreXml` 未消费。 |
| 建议 | 在 `coreXml` 签名增加 `subtitle` 参数并写入 `<dc:description>`，与 DOCX 对齐。影响很小。 |

### P3-2 [小问题] PPTX ZIP 用 store 模式（无压缩），文件偏大

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownPptx.ts:58-135`（`zipStore`） |
| 现象 | 手搓 ZIP 用 method=0（store，无压缩），PPTX 文件体积大于标准 deflate 压缩。含多张截图时差异明显。 |
| 根因 | 零依赖设计取舍（注释 line 3 说明「手搓 store 模式 ZIP」）。PowerPoint 可正常打开 store 模式 ZIP。 |
| 建议 | 可接受。若体积成问题，可引入 `pako`（docx 库已间接依赖）做 deflate，或改用 `jszip`。 |

### P3-3 [小问题] HTML 表格分隔行检测可能误判含连字符的单元格

| 字段 | 内容 |
|---|---|
| 文件:行号 | `src/features/ai/markdownHtml.ts:490-491` |
| 现象 | 表格检测条件 `lines[i + 1].includes('-') && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])`，第二行只含 `|`/`:`/`-`/空格才视为分隔行。但若表头单元格本身是 `| a-b | c |`，下一行是数据行 `| 1 | 2 |`，不会误判（数据行含数字）。风险较低。 |
| 建议 | 当前实现足够稳健，无需改动。 |

---

## 三、亮点（非问题，确认真实可用）

1. **DOCX 截图内嵌真实有效**：`markdownDocx.ts:217-252` 用 `ImageRun` + `decodeDataUrl` + `loadImageSize` 真实解码 base64 → bytes，按真实宽高比缩放（MAX_W=600），type 映射覆盖 PNG/JPEG/GIF/BMP。`Packer.toArrayBuffer` 正确选择 webview 兼容路径（line 635 注释说明避免 `nodebuffer`）。

2. **PPTX 截图内嵌真实有效**：`markdownPptx.ts:743-793` 通过 store-ZIP 把截图字节写入 `ppt/media/imageN.png`，并在 slide `.rels` 中建立 `image` 关系，`<p:pic>` + `<a:blip r:embed="rIdN"/>` 正确引用。`layoutPics`（line 430-465）按真实宽高比排布、超限时等比缩放，避免拉伸/重叠。

3. **PPTX 表格渲染为真实 OOXML 表格**：`markdownPptx.ts:318-426` 把 GFM 表格解析为 `<p:graphicFrame>` + `<a:tbl>`，含表头底色、边框、列对齐，非降级为纯文本。`parseBodyBlocks` 把正文拆成文本块/表格块分别渲染。

4. **PPTX core.xml 元数据已修复**：`markdownPptx.ts:660-670, 814` 写入真实标题 + 导出时刻 ISO（`W3CDTF` 格式 `2026-07-18T12:34:56Z`），历史假实现已消除。

5. **SNAP 章节内嵌三端一致**：DOCX/HTML/PPTX 均用 `parseInt(marker[1], 10) - 1` 把 1 基标记转 0 基数组索引，行为一致，无 off-by-one。

6. **PDF 打印等待图片解码**：`AIPanel.tsx:69-92` `printHtmlViaIframe` 在 `iframe.onload` 后等所有 `<img>` 解码完成（含 base64 截图）再触发 `print()`，2.5s 兜底超时，避免图文报告 PDF 空白/截断。

7. **导出路径记忆 + 智能文件名**：`exportPath.ts` 实现目录记忆（localStorage）、文件名消毒、首轮目标摘要，失败静默回退，设计稳健。

8. **Finder 定位 + 打开文件按钮真实可用**：`revealInFolder` 调用 Rust `reveal_in_folder`（`open.rs:48-61`，复用 `tauri-plugin-opener`），`openExported` 调用 `open_path`（capability `opener:allow-open-path` 已授予）。PDF 因不落盘而不显示按钮，行为诚实。

9. **XLSX 列宽自适应真实生效**：`markdownXlsx.ts:117-130` 按 CJK 全角字符占 2 wch 计算列宽，`!cols` 是 SheetJS 社区版真实支持写入的属性。

10. **ZIP 归档真实可用**：`handleHistoryZip`（`AIPanel.tsx:551-592`）打包成稿 md + 对话 json + 来源截图 + README，复用 `buildZip`。

---

## 四、优先级排序表

| 优先级 | 问题 | 文件 | 类型 | 影响 |
|---|---|---|---|---|
| P0 | XLSX 表头加粗/底色被静默丢弃 | markdownXlsx.ts:114 | 假实现 | 用户看到代码「在加粗」但产物无效果 |
| P0 | PPTX JPEG 截图错标 `.png` | markdownPptx.ts:769,716 | 格式错乱 | JPEG 截图导出 PPT 可能损坏/不显示 |
| P1 | PDF 不落盘（系统打印式） | AIPanel.tsx:1047 | 设计局限 | 唯一无落盘/Finder 按钮的格式 |
| P1 | PPTX 主题色与 UI 5 套不一致 | markdownPptx.ts:12 | 缺陷 | 3 套主题静默回退蓝色 |
| P1 | DOCX WebP/SVG 错标 PNG | markdownDocx.ts:232 | 健壮性 | 非常见格式截图 Word 报错 |
| P2 | MD/TXT/HTML/PDF 无 loading 态 | AIPanel.tsx:888 | UX | 导出中无反馈，可重复点击 |
| P2 | 历史库导出无禁用态 | AIPanel.tsx:430 | UX | 可叠加多个保存弹窗 |
| P2 | PPTX 只按 H1/H2 断页 | markdownPptx.ts:229 | 一致性 | H3-H6 降级为正文 |
| P3 | PPTX core.xml 未写 description | markdownPptx.ts:660 | 一致性 | 与 DOCX 元数据不对齐 |
| P3 | PPTX ZIP store 无压缩 | markdownPptx.ts:58 | 体积 | 文件偏大，可接受 |
| P3 | HTML 表格分隔行检测 | markdownHtml.ts:490 | 健壮性 | 风险极低，当前稳健 |

---

## 五、新需求建议（审计中发现的改进机会）

1. **PDF 真落盘**：引入 `pdf-lib` 或 Rust 侧 `printpdf`，让 PDF 与其他 5 种格式体验一致（一键落盘 + Finder 定位）。
2. **XLSX 样式真生效**：迁移到 `exceljs` 或手搓 `xl/styles.xml`，让表头加粗/底色/冻结首行真实写入。
3. **PPTX 主题对齐**：统一 5 套主题在 DOCX/HTML/PPTX 三端的配色，删除 UI 不可选的 PPTX 主题 key。
4. **导出统一 loading**：所有格式（含 MD/TXT/HTML/PDF）接入 `exporting` 状态机，按钮统一「导出中…」反馈。
5. **图片格式智能处理**：DOCX/PPTX 在写入前检测实际图片格式，按真实 MIME 命名 + 声明 Content-Type，WebP/SVG 预转码为 PNG。

---

*报告结束。audit-export 产出，待 team-lead 审阅。*
