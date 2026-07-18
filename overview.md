# AI 文档生成 · 本轮优化（2026-07-17）

## 方向收口（用户铁则）
> "我们只做对平台友好的，不追微软各版本特殊兼容。"

据此：
- **砍掉 P1-④「真·可更新 TOC 域」** —— 恰恰是微软版本兼容那一套（域代码 / 页码域 / WPS 旧版行为各异），保留现有静态章节速览即可。
- **保留 P1-⑤ 表格质量** —— 列对齐 / 内联格式 / 表头跨页重复都是标准 OOXML（ISO 29500），Word / WPS / Pages / LibreOffice 全平台通吃，不绑任何微软版本。

## 已修（纯前端增量，0 Rust、0 新依赖）

### P1-⑤ DOCX 表格质量（`src/features/ai/markdownDocx.ts`）
1. **列对齐**：GFM 分隔行 `:---` / `:---:` / `---:` 现在真正生效。
   - 坑位：caller 收集表格时 `i += 2` 已跳过分隔行，旧 `buildTable` 却误把 `rows[1]`（首数据行）当分隔行 → 对齐全 `left` 且**丢首数据行**。改为 caller 把分隔行单独传给 `buildTable(separator)` 推导对齐。
2. **单元格内联格式**：数据单元格改用 `parseInline(c, accent, CJK_FONT)`，解析 `**粗体**` / `*斜体*` / `` `代码` `` / `~~删除~~` / 链接；表头保持纯文本加粗（稳健）。`parseInline` 加可选 `defaultFont` 参数（不传不影响正文渲染）。
3. **表头跨页重复**：`tableHeader: ri === 0` 即标准 `<w:tblHeader/>`，**原本已实现**，运行时验证 XML 含该标记，全平台兼容，无需改动。

### P1-③ DOCX macOS 字体（上轮已修，本轮一并核验）
`CJK_FONT` 改为字体对象 `{ ascii:'Calibri', hAnsi:'Calibri', eastAsia: IS_MAC?'PingFang SC':'Microsoft YaHei' }`，消除 Word/WPS Mac「字体缺失」替换。

## 验证
- `pnpm build` exit 0。
- esbuild 转译 `markdownDocx.ts` 后 Node 生成「含左/中/右对齐 + `**粗体**`/`*斜体*`/`` `代码` `` 」的表格 DOCX，解包断言以下全部出现 → **ALL PASS**：
  - `<w:tblHeader/>`（表头重复）
  - `<w:jc w:val="left|center|right"/>`（三种对齐）
  - `<w:b/>` / `<w:i/>` / `Courier New`（内联粗体/斜体/代码）
  - `Calibri`（CJK 字体对象）

## 未完成（待你定）
- P2-⑥ `.txt` 降级残留 ```` ``` ```` 代码围栏与表格竖线
- P2-⑦ PDF 回退内嵌图用 `replace('</body>', …)` 较脆弱
- P2-⑧ md/txt/html/preview 按钮缺「导出中」态（仅 docx/xlsx/pptx 有）

按「一个功能一个功能」节奏，下一功能待你指定。
