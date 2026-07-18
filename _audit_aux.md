# snap-craft AI 助手「生成文档」附属功能深度审计报告

> 审计范围：附带截图、附带OCR、润色、重写截图、AI智能编辑工具、会话打包（纯前端）
> 审计员：audit-aux | thoroughness: very thorough | 仅分析不改文件
> 审计日期：2026-07-18
> 仓库：/Users/liwenchao/GithubProSpace/snap-craft

---

## 总览结论

| 审计项 | 结论 | 真实性 |
|---|---|---|
| 附带截图 | **真发图**给多模态模型（content 数组含 image_url / image source） | ✅ 真实现 |
| 附带OCR | **真拼进 prompt**（buildDefaultUser 把 OCR 包在 `"""..."""` 注入 user 消息） | ✅ 真实现 |
| 润色 | **真二次调 AI**（refine → streamChat，流式展示） | ✅ 真实现 |
| 重写截图后重OCR | **真重跑 OCR**（refreshAiVision 对合成图重新 ocr_image） | ✅ 真实现 |
| AI智能编辑工具 | **真执行**（addAnnotation 落画布 + flashRegion 可视化 + 工具循环回写） | ✅ 真实现 |
| 会话打包 zip | **真生成 zip**（零依赖 store 模式 + CRC32，经 save_binary_file 落盘） | ✅ 真实现 |

**总体评价**：六大附属功能均为真实实现，无空实现/假实现。核心链路（发图→OCR→润色→工具循环→打包）闭环完整。但存在若干边界 bug、数据不一致与潜在隐私风险，详见下文。

---

## 1. src/features/ai/aiTools.ts（241行）— 工具集

### 1.1 工具是否真执行 ✅
工具定义 `AI_TOOL_DEFS`（L59-153）声明 6 个工具：`draw_rectangle` / `redact_area` / `highlight_text` / `draw_arrow` / `draw_callout` / `summarize_region`。`createToolExecutor`（L161-208）把工具调用派发到 `AiToolHost` 接口。宿主实现有两套：
- 主窗口直连：`EnhancedScreenshotApp.tsx` L2310-2524 —— 直接调 `addAnnotation` 写画布 + `flashRegion` 可视化。
- AI 独立窗口：`RemoteToolHost.ts` —— 经 IPC（`emitTool`/`callTool`）转发主窗口执行。

两套都是真执行，非空实现。

### 1.2 参数校验与坐标归一化 ✅（有亮点）
`clamp01`（L155）把所有 0~1 坐标钳制到 `[0,1]`，防御越界：
```ts
// aiTools.ts L155
const clamp01 = (v: any): number => Math.max(0, Math.min(1, Number(v) || 0));
```
**亮点**（L166-173）：防御隐私哨兵 prompt 误用的嵌套 `{r:{x,y,w,h}}` 结构，避免打码坐标塌成 0：
```ts
// aiTools.ts L166-173
const rr = (args && typeof args.r === 'object' && args.r) ? args.r : {};
const r: NormRect = {
  x: clamp01(args.x ?? rr.x),
  y: clamp01(args.y ?? rr.y),
  w: clamp01(args.w ?? rr.w),
  h: clamp01(args.h ?? rr.h),
};
```
坐标换算（0~1 → 像素）在宿主侧完成，三处实现一致：
- `EnhancedScreenshotApp.tsx` L36-42 `normToPx`：`Math.round(clamp01(r.x) * W)`
- `EditorWindow.tsx` L41 同名函数
- `RemoteToolHost.ts` L33-42 `toPx`：同样 `Math.round(clamp01(r.x) * W)`

三处完全一致，坐标转换正确。

### 1.3 undo 栈 ✅
`EnhancedScreenshotApp.tsx` L2298 注释明确：「经既有 store.addAnnotation 写入标注（与用户手动标注同路、自动入撤销历史）」。工具产物走 `addAnnotation` → 进入既有 undo 栈，无独立 undo 层。设计合理。

### 1.4 getMergedImageDataUrl 合成 ✅
`AnnotationCanvas.tsx` L1313 暴露 `getMergedImageDataUrl: mergeToDataUrl`。在 `refreshAiVision`（EnhancedScreenshotApp L2260-2287）中调用，合成「底图 + 全部标注」用于 AI 视觉。合成后还会重新 OCR（见第 5 节）。

### 1.5 问题：summarizeRegion 用原图而非合成图（隐私漏洞）⚠️ 中
```ts
// EnhancedScreenshotApp.tsx L2505-2520
summarizeRegion: async (r) => {
  const W = current?.width ?? 0;
  const H = current?.height ?? 0;
  if (!W || !H) return '(无图)';
  const { x, y, w, h } = normToPx(r, W, H);
  const crop = await cropDataUrl(current?.dataUrl ?? '', x, y, ...);  // ← 用原始 dataUrl
  const res = await invoke<OcrResult>('ocr_image', { imageData: crop, ... });
  return cleanOcrText(res?.text).trim() || '(该区域未识别到文字)';
}
```
`summarizeRegion` 裁剪的是 `current.dataUrl`（原始截图），**不是** `getMergedImageDataUrl()` 合成后的编辑图。这意味着：如果模型先 `redact_area` 打码某区域，再 `summarize_region` 识别同一区域，会拿到**打码前的原始文字**——打码形同虚设。
- 隐私哨兵模式通过 system prompt 禁止调用 `summarize_region`（aiTools.ts L236-240），降低了风险；
- 但通用智能编辑模式（agentKind='edit'）无此限制，模型可在打码后调用 `summarize_region` 还原敏感文字，且结果会进入对话历史与 tool_result。
- **建议**：`summarizeRegion` 应优先用 `getMergedImageDataUrl()` 合成图裁剪，或至少在检测到该区域已被 mosaic/redact 标注覆盖时返回 `(已打码)`。

### 1.6 问题：drawArrow/drawCallout 坐标未 round（轻微不一致）ℹ️ 低
```ts
// EnhancedScreenshotApp.tsx L2416-2419
const fx = clamp01(from.x) * W;  // float，未 Math.round
const fy = clamp01(from.y) * H;
```
而 `drawRectangle`/`redactArea`/`highlightRect` 走 `normToPx`（有 `Math.round`）。`drawArrow`/`drawCallout` 直接 `clamp01 * W` 得到浮点像素。对 canvas 绘制影响极小（canvas 会抗锯齿），但返回给模型的坐标串（L2462 `fx.toFixed(0)`）与实际绘制坐标存在亚像素偏差。功能无碍，仅一致性问题。

---

## 2. src/features/ai/ocrClean.ts（95行）— OCR 清理

### 2.1 清理规则有效性 ✅
四类清理覆盖 macOS Vision / Windows WinRT 常见乱码：
- 零宽字符 `[\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]`（L21）
- 控制字符 `[\x00-\x08\x0B-\x1F\x7F]`（L23），正确保留 `\n\r\t`
- 3+ 连续空格 → 1（L25）
- 单字 10+ 连续重复 → 保留前 4（L27），阈值合理（5-9 次可能是合法叠字）

### 2.2 是否破坏原文 ✅（安全）
- 正则均只匹配明确的噪音字符集，不删 ASCII 字母数字/标点/中文汉字。
- `REPEATED_CHAR_RE`（L27）范围 `[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEFa-zA-Z0-9]` 精确覆盖 CJK + 全角 + ASCII，不会误删其他文字。
- 超长行截断（L62-67）在 500 字符处加 `…`，防御 OCR 超长行撑爆上下文。

### 2.3 中文处理 ✅
- 零宽字符清理对中文混排有效（macOS Vision 对中文常插入 U+200B）。
- `MAX_LINE_CHARS = 500`（L29）对中文合理（约 500 汉字）。

### 2.4 问题：cleanOcrTextWithStats 统计与实际清洗顺序不一致 ℹ️ 低
```ts
// ocrClean.ts L84-89  统计阶段
const zeroWidth = (input.match(ZERO_WIDTH_RE) || []).length;
const control = (input.match(CONTROL_RE) || []).length;
const spaceRuns = (input.match(MULTI_SPACE_RE) || []).length;
const repeated = (input.match(REPEATED_CHAR_RE) || []).length;
const longLines = input.split(/\r?\n/).filter((l) => l.length > MAX_LINE_CHARS).length;
```
统计是在**原始 input** 上 match，而 `text = cleanOcrText(input)`（L90）是顺序清洗（先去零宽→再去控制→再合并空格→再截重复→再截长行）。由于清洗是顺序的，`repeated` 的统计发生在零宽/控制字符已删除后的文本上，而统计却用原始 input match `REPEATED_CHAR_RE`。若原文中重复字之间夹杂零宽字符，统计数会偏少（零宽打断连续重复）。仅影响调试统计准确性，不影响清洗结果。

### 2.5 问题：MULTI_SPACE_RE 把 \u00A0（不间断空格）合并为普通空格 ℹ️ 低
```ts
// ocrClean.ts L25
const MULTI_SPACE_RE = /[ \u00A0]{3,}/g;
```
3+ 个 `\u00A0` 会被替换成普通空格 ` `。在绝大多数场景无害，但若 OCR 原文用 `\u00A0` 作为语义分隔（如表格列分隔），合并后可能丢失格式。极边缘，可忽略。

---

## 3. src/features/ai/toolCallParser.ts（464行）— parseShapedToolCalls

### 3.1 国产模型 stream 解析兜底 ✅（设计扎实）
支持 5 种文本形态（L7-12）：
1. JSON 围栏 ```json {...} ```
2. JSON 裸对象 `{...}` / `[{...}]`
3. XML `<tool_call name="...">{...}</tool_call>`
4. Bracketed `[tool]{...}[/END_TOOL_REQUEST]`
5. ReAct `Action: tool\nAction Input: {...}`

主入口 `parseShapedToolCalls`（L413-430）按 JSON→XML→Bracketed→ReAct 顺序识别，`dedupeByFingerprint`（L388-398）按指纹去重，避免同调用被多形态重复解析。

### 3.2 JSON 容错 ✅（亮点）
`findBalancedJsonEnd`（L132-162）实现了真正的括号深度计数 + 字符串内转义跳过：
```ts
// toolCallParser.ts L141-150
if (inString) {
  if (escaped) escaped = false;
  else if (ch === '\\') escaped = true;
  else if (ch === '"') inString = false;
  continue;
}
```
`MAX_JSON_CANDIDATE_CHARS = 12_000`（L130）防御超长 JSON 撑爆解析。单条解析失败不阻断其它（L202-204 try/catch）。

### 3.3 多工具支持 ✅
`extractCallsFromValue`（L208-240）递归处理数组、`tool_calls` 数组、嵌套 `function` 字段，可一次解析多个工具调用。

### 3.4 问题：ReAct 正则不支持嵌套 JSON 参数 ⚠️ 中
```ts
// toolCallParser.ts L353-354
const REACT_RE =
  /(?:^|\n)\s*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})\s*(?:\r?\n)+\s*Action Input\s*:\s*(\{[\s\S]*?\})/g;
```
`(\{[\s\S]*?\})` 是**非贪婪**匹配，匹配从 `{` 到**第一个** `}`。若参数含嵌套对象（如 `{"text":"a{\"b\":1}"}` 或 `{"opts":{"color":"#fff"}}`），会只截到内层第一个 `}`，导致 `JSON.parse(body)` 失败，工具调用被静默丢弃。
- 对比：Bracketed 正则（L319）虽同样非贪婪，但尾部有 `\[\/END_TOOL_REQUEST\]` 锚点，回溯机制可保证匹配到正确的 `}`。ReAct 无尾部锚点，无法回溯。
- 实际影响：当前 6 个工具的参数均为扁平结构（无嵌套对象），故暂不触发。但若未来工具参数扩展为嵌套，ReAct 路径会失效。
- **建议**：ReAct 的 body 匹配改用 `findBalancedJsonEnd` 而非正则。

### 3.5 问题：looksLikeShapedToolCall 粗筛可能误报 ℹ️ 低
```ts
// toolCallParser.ts L408
/\{\s*["']?(?:name|tool_name|function)["']?\s*:/i
```
任何含 `"name":` 的 JSON 都会触发深度解析。若 AI 在正文中举例 `{"name":"张三"}`，会误触解析（但 `hasToolShape` L109-118 要求 name 合法 + args 非空，多数误报会被过滤）。极边缘。

### 3.6 问题：XML 闭合标签容错正则可能过度匹配 ℹ️ 低
```ts
// toolCallParser.ts L258
const XML_TOOL_RE = /<tool_call\b([^>]*?)>([\s\S]*?)<\/\s*[\s\S]{0,5}?tool_call\s*>/gi;
```
`[\s\S]{0,5}?` 允许闭合标签 `</` 与 `tool_call` 间有最多 5 个任意字符。若正文中有 `</x tool_call>` 之类的无关文本，可能误匹配。极边缘。

---

## 4. src/features/ai/zipStore.ts（145行）— 会话打包

### 4.1 是否真生成 zip ✅
`buildZip`（L52-135）手搓 ZIP store 模式（method=0 不压缩）：
- 本地文件头 `0x04034b50`（L79）+ 中央目录 `0x02014b50`（L99）+ EOCD `0x06054b50`（L124），结构完整。
- CRC32（L7-26）标准 IEEE 802.3 实现，查表法正确。
- UTF-8 文件名标志位 `0x0800`（L81）正确设置，中文文件名兼容。
- 调用链：`AIPanel.handleHistoryZip`（L551-592）→ `buildZip(files)` → `invoke('save_binary_file', { bytes: Array.from(zip), filePath: path })` 落盘。真生成真落盘。

### 4.2 内容完整性 ✅
```ts
// AIPanel.tsx L554-577
files.push({ name: 'conversation.md', data: enc.encode(md) });           // 成稿
files.push({ name: 'conversation.json', data: enc.encode(JSON.stringify(activeConv.conv, null, 2)) }); // 原始对话
if (thumb) files.push({ name: 'source.png', data: bytes });              // 来源截图缩略图
files.push({ name: 'README.txt', data: enc.encode(readme) });            // 说明
```
含成稿 md + 原始对话 json + 来源截图 + README，内容完整。

### 4.3 问题：zip 仅含缩略图，不含完整原图与编辑产物 ℹ️ 低
`handleHistoryZip`（L562-565）只取 `activeConv.meta.thumb`（200px 缩略图）作为 `source.png`，不含完整原图或编辑后截图。若用户期望从 zip 恢复高清截图，会失望。但作为「会话归档」定位，缩略图已够用。

### 4.4 问题：dataUrlToBytes 不支持含 + 的 MIME 类型 ℹ️ 低
```ts
// zipStore.ts L139
const m = /^data:[\w\/\-\.]+;base64,(.*)$/.exec(dataUrl);
```
`[\w\/\-\.]` 不含 `+`，故 `data:image/svg+xml;base64,...` 无法匹配。当前截图均为 PNG/JPEG，不影响。但若未来有 SVG，会静默返回 null。

### 4.5 问题：zip 未设置文件时间为原文时间 ℹ️ 低
```ts
// zipStore.ts L58-62
const now = new Date();
const dosTime = ((now.getHours() << 11) | ...);
const dosDate = (((now.getFullYear() - 1980) << 9) | ...);
```
所有文件用打包时刻，而非会话原始 `updatedAt`。归档时间语义略有偏差，不影响使用。

---

## 5. src/features/ai/AIPanel.tsx — 附属功能审计

### 5.1「附带截图」开关：是否真发图 ✅（真实现，非假实现）

**核心验证**：截图 dataUrl 真的以 `image_url` 形式进入 messages content 数组，而非只在 prompt 提"有截图"。

数据流：
1. AIPanel `handleGenerate`（L686-693）传 `imageDataUrl: visionImg` 给 `generate`
2. aiStore `chat`（L714-719）首轮拼 images：
```ts
// aiStore.ts L714-719
images = ctx.preset.vision
  ? [
      ...(attachImage && ctx.imageDataUrl ? [ctx.imageDataUrl] : []),
      ...(ctx.images ?? []),
    ]
  : undefined;
```
3. aiClient `toOpenAiMessages`（L65-74）构建多模态 content：
```ts
// aiClient.ts L65-74
const imgs = collectImages(m);
if (imgs.length > 0) {
  return {
    role: m.role,
    content: [
      { type: 'text', text: m.content },
      ...imgs.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}
```
4. Anthropic 路径（L110-121）同样构建 `image` source block（base64）。

**结论**：附带截图是**真发图**，content 数组含 `image_url`（OpenAI）/ `image` source（Anthropic）。

**多截图选择与顺序**：`selectedOrder`（L338）持久化到 localStorage（L153 `saveSel`），拖拽重排（L365-379），发送时按选择顺序映射（L681-684）。顺序正确传递到 `images[]`，`collectImages` 保持插入顺序（L40 `Array.from(new Set(all))` 去重但保序）。

### 5.1.1 问题：attachImage 只控当前图，不控附加图 ⚠️ 中（数据不一致）
```ts
// aiStore.ts L714-719
images = ctx.preset.vision
  ? [
      ...(attachImage && ctx.imageDataUrl ? [ctx.imageDataUrl] : []),  // ← 受 attachImage 控制
      ...(ctx.images ?? []),                                           // ← 不受 attachImage 控制
    ]
  : undefined;
```
用户取消勾选「附带截图」时，**只移除当前截图，附加截图仍发送**。UI 标签 `t('ai.attachImage')`（L1455）泛指"附带截图"，未区分当前/附加，用户会以为取消后所有截图都不发。这是一个数据不一致：开关语义与实际行为不符。

### 5.1.2 问题：preset.vision=false 时静默丢图 ⚠️ 中
`ctx.preset.vision` 为 false 时（自定义预设可设 vision:false，内置预设均为 true），images 整体置 undefined，即使 `attachImage` 已勾选。UI 未在 `preset.vision=false` 时禁用「附带截图」复选框（L1444-1457 只在 `!imageDataUrl || agentMode || sentinelMode` 时 disable）。用户勾选了"附带截图"但图被静默丢弃，是"假实现感"的来源（虽非有意造假）。

### 5.2「附带识别文字(OCR)」开关：是否真拼进 prompt ✅

**核心验证**：
1. aiStore `chat`（L708-712）：
```ts
// aiStore.ts L708-712
userContent = ctx.preset.buildUser({
  goal: text,
  ocrText: attachOcr ? ctx.ocrText : undefined,
  ocrTexts: attachOcr ? ctx.ocrTexts : undefined,
});
```
2. aiPresets `buildDefaultUser`（L39-50）调 `withOcr`（L29-33）：
```ts
// aiPresets.ts L29-33
function withOcr(ocrText?: string, label?: string): string {
  if (!ocrText || !ocrText.trim()) return '';
  return `\n\n以下是截图${tag}中通过 OCR 识别出的原文文字，供你参考、引用或整合...\n"""\n${ocrText.trim()}\n"""`;
}
```
OCR 文本真拼进 user 消息，包在 `"""..."""` 内，带「（当前）」「（附加1）」标签区分多图。

**OCR 来源**：`ocrText` prop 来自宿主 `aiOcrText`（EnhancedScreenshotApp L2581），由 `runOcr`（L1648）调系统原生 OCR（`invoke('ocr_image')`）生成，经 `cleanOcrText` 清洗。

**空 OCR 处理**：`withOcr`（L30）`if (!ocrText || !ocrText.trim()) return ''` —— 空 OCR 不拼，安全。UI 复选框在 `!ocrText` 时 disable（L1458-1464）。

### 5.3「润色」功能：是否真二次调 AI ✅

**核心验证**：aiStore `refine`（L962-1009）：
```ts
// aiStore.ts L967-969
const messages: AiMessage[] = [
  { role: 'system', content: refineSystem() },
  { role: 'user', content: `${instruction}\n\n${output}` },
];
```
```ts
// aiStore.ts L977-984
const full = await streamChat({
  config,
  messages,
  onChunk: sink.onChunk,   // ← 流式回写
  onUsage: (u) => set({ usage: u }),
  onThinking: sink.onThinking,
  signal: ctl.signal,
});
```
**真二次调 AI**（streamChat），把上一轮 `output` + 润色指令发给模型，流式展示（`sink.onChunk` 100ms 批量 flush）。

**prompt 合理性**：`refineSystem`（L81-86）要求"严格按要求改写，保持原意与关键信息不变，直接输出改写后的全文（保持 Markdown 格式，不要额外解释）"。5 个润色选项（AIPanel L1662-1693）：缩短 / 加长 / 正式 / 口语 / 英文。指令合理。

**结果回写**：润色结果回写对话线程末条 assistant（L986-991），保持 conversation 单一数据源。

### 5.4「重写/会写截图」：合成后是否重新 OCR 防泄露 ✅（隐私哨兵已实现）

**核心验证**：`refreshAiVision`（EnhancedScreenshotApp L2260-2287）：
```ts
// EnhancedScreenshotApp.tsx L2264-2282
const merged = canvasRef.current ? await canvasRef.current.getMergedImageDataUrl() : null;
const visionUrl = merged || fallback;
setAiVisionUrl(visionUrl);
// 仅当真正合成了「编辑后图」（与原图不同）才重跑 OCR
if (merged && merged !== fallback) {
  try {
    const res = await invoke<OcrResult>('ocr_image', {
      imageData: merged,           // ← 对合成图（含打码）重新 OCR
      lang: ocrLang === 'auto' ? null : ocrLang,
    });
    const cleanedText = cleanOcrText(res?.text);
    setAiOcrText(cleanedText || rawOcr);   // ← 更新 OCR 为打码后的版本
  } catch {
    setAiOcrText(rawOcr);
  }
} else {
  setAiOcrText(rawOcr);
}
```
**真重跑 OCR**：对 `getMergedImageDataUrl()` 合成图（底图 + 全部标注，含打码/模糊）重新 `ocr_image`。打码区域的文字在合成图中已被破坏，OCR 识别不出，故 `aiOcrText` 不再含敏感文字。**隐私哨兵防泄露已实现**。

**触发时机**：AIPanel L600-607，流式结束（streaming→done/error）时调 `requestRefresh()` + `notifyAiCommit()`：
```ts
// AIPanel.tsx L600-607
useEffect(() => {
  if (prevStatusRef.current === 'streaming' && status !== 'streaming') {
    requestRefresh();
    notifyAiCommit();
  }
  prevStatusRef.current = status;
}, [status]);
```
Agent 改完画布 → 流式结束 → 触发主窗口 refreshAiVision → 重算 visionUrl + 重 OCR → 推回 AI 窗口。闭环完整。

### 5.4.1 问题：哨兵运行期间 OCR 仍是打码前版本（设计权衡，非 bug）ℹ️ 低
`runAgent`（aiStore L1036-1042）在构建 messages 时注入的 `input.ocrText` 是**运行开始时**的 OCR（含敏感文字）。模型在哨兵轮内能读到敏感文字的 OCR —— 这是**故意的**：模型需要知道哪些文字敏感才能决定打码区域。运行结束后 `refreshAiVision` 重 OCR，后续轮不再含敏感文字。设计合理。

### 5.4.2 问题：打码前 OCR 持久化在对话历史/长期记忆 ⚠️ 中（隐私残留）
`runAgent` 把含敏感文字的 `userContent`（含 OCR）写入 `newConv`（L1064），并 `saveConversation(convKey, finalConv)`（L1098）落盘 localStorage。若对话超长触发 `compactMemory`（L1103-1105），敏感文字还可能被压缩进长期记忆 `memories`（L879-932）持久化。

即：**视觉上已打码，但对话历史/记忆里仍存有敏感文字明文**。用户以为打码了就安全，实则 localStorage 仍有残留。
- 这是「附带 OCR」功能的固有代价（用户主动选择把 OCR 文字发给模型并入库）；
- 但对「隐私哨兵」场景，用户的心智模型是"打码=安全"，与 OCR 残留矛盾。
- **建议**：哨兵模式运行结束后，可考虑把对话历史中的 OCR 片段替换为 `(已打码，OCR 已移除)`，或至少在哨兵报告里提示"对话历史仍含识别前文字"。

### 5.5 AI 智能编辑工具循环：flash 可视化、工具执行、结果回写 ✅

**工具循环**（aiClient `streamChatWithTools` L681-800）：
- 最多 8 轮（`maxToolTurns: 8`，L1084），每轮发请求 → 解析 tool_calls → 派发 executor → 结果回传模型 → 下一轮。
- 失控循环检测（L744-752, L783-786）：连续 3 次相同工具调用指纹即终止，防模型空转。
- shaped text 兜底（L717-737）：原生 tool_calls 为空时从文本解析，并 `stripShapedToolCallsText` 抹除。

**flash 可视化**：每个工具执行后调 `canvasRef.current?.flashRegion(...)`（EnhancedScreenshotApp L2352/2384/2409/2457/2498），在画布上脉冲高亮被操作区域。UI 实时回显 `agentSteps`（AIPanel L1977-1994，L2092-2111），含 ⏳/✓/⚠️ 状态、工具名、参数摘要、shaped 标签。

**工具执行**：`createToolExecutor(input.host)`（aiStore L1083）→ host 的 `drawRectangle`/`redactArea`/... → `addAnnotation` 真实落画布 + `flashRegion` 可视化。

**结果回写**：`onToolCall`（L1089）推 step，`onToolResult`（L1090-1093）回填 result/isError。最终 `full` 文本写回 `output` 与对话线程（L1096-1098）。

### 5.5.1 问题：Agent 运行期间模型看不到自己打码后的图 ℹ️ 低（设计权衡）
`runAgent` 的 messages 在循环开始时构建一次（含初始 image），工具循环内后续轮只追加 assistant/tool 文本消息，**不更新 image**。模型基于原图规划所有打码，看不到中间结果。这是合理设计（模型一次性规划），但若模型想"打码后检查效果"则做不到。`summarize_region` 工具可部分弥补（但见 1.5 的原图问题）。

### 5.5.2 问题：RemoteToolHost 的 callTool 存在 listen/emit 竞态 ⚠️ 中
```ts
// bridge.ts L324-327
listen<ToolResultMsg>(EVT_TOOL_RESULT, handler).then((u) => {
  unsub = u;
});
void emitTo(aiHost, EVT_TOOL, { callId, name, args }).catch(() => {});
```
`listen()` 是异步的（返回 Promise），但 `emitTo` 紧接着同步发出，**未 await listen 完成**。若主窗口处理极快（如 draw_rectangle 的 addAnnotation 很快），在 listen 注册完成前就 emit 了结果，handler 不会触发，只能等 15s 超时兜底（L329-332）。
- 实际影响：`summarize_region`（需 OCR，耗时较长）几乎不受影响；但 draw/redact 等 fire-and-forget 工具不走 callTool（走 emitTool），不受影响。真正受影响的是「快速完成的请求/响应工具」——目前只有 `summarize_region` 走此路径，而它够慢，竞态概率极低。
- **建议**：先 `await listen(...)` 注册完成，再 `emitTo`。

---

## 6. 其他发现

### 6.1 问题：润色不携带截图/OCR 上下文 ℹ️ 低（设计权衡）
`refine`（aiStore L967-969）的 messages 只含 `[system, user]`，user 是 `${instruction}\n\n${output}`，**不含图片、不含 OCR、不含预设 system**。润色是纯文本迭代，不重新看图。设计合理（润色的是已生成文本），但若用户期望"基于截图重新润色"会失望——需用「追问」而非「润色」。

### 6.2 问题：refine 把整段 output 拼进 user 消息，超长会触发 400 ⚠️ 中
```ts
// aiStore.ts L969
{ role: 'user', content: `${instruction}\n\n${output}` },
```
`output` 可能很长（图文报告数千字），`refine` 不走 `trimHistoryToBudget`（chat/runAgent 都走了，L728/1052），直接拼进 user 消息。若 output 极长（如 10 万字），会触发 API 400/413。
- **建议**：refine 也应对 messages 做预算护栏，或至少对 output 截断。

### 6.3 问题：historyList 缩略图用完整 dataUrl 渲染 ⚠️ 中（性能）
`handleHistoryZip`/`handleHistoryExport` 用的 `activeConv.meta.thumb` 是 200px 缩略图（aiStore L247-274 downscaleThumb），OK。但 AIPanel L2382 历史列表 `meta.thumb` 渲染 `<img>`，以及 L1368 多截图附加 `it.data_url`（**完整原图**）渲染缩略图网格。多截图附加面板若历史图多（如 50 张 2MB 图），`<img src={it.data_url}>` 会把 100MB dataUrl 塞进 DOM，卡顿明显。
- **建议**：附加面板的缩略图也应走 downscale 生成小图，而非直接用 `data_url`。

### 6.4 问题：saveConversation 把含图 dataUrl 的 conversation 落 localStorage ⚠️ 中（配额）
`saveConversation`（aiStore L174-180）把 `AiChatTurn[]` JSON.stringify 落 localStorage。conversation 的 user 消息可能含 `images`（多图 dataUrl，每张数 MB）。JSON.stringify 后体积巨大，极易触发 localStorage 配额超限（通常 5-10MB）。
- 实际：首轮 user 消息的 `images` 字段会被 stringify。虽然 `saveConversation` 有 try/catch 静默失败，但失败后「重开恢复」会丢对话。
- **建议**：落盘前剥离 user 消息的 `images` 字段（图片可从截图历史恢复，无需存对话里）。

### 6.5 问题：convHash 只取前 1024 字符哈希 ℹ️ 低
```ts
// aiStore.ts L153-161
export function convHash(s?: string): string {
  if (!s) return 'noimage';
  const sample = s.length > 1024 ? s.slice(0, 1024) : s;
  let h = 5381;
  for (let i = 0; i < sample.length; i++) {
    h = ((h << 5) + h + sample.charCodeAt(i)) | 0;
  }
  return 'img-' + (h >>> 0).toString(36) + '-' + s.length.toString(36);
}
```
两张图若前 1024 字符相同（如相同 PNG 头 + 少量像素），且长度相同，会哈希碰撞 → 对话线程串扰。dataUrl 的 base64 前缀 `data:image/png;base64,` 相同，但后续像素 base64 通常不同，碰撞概率极低。加了 `s.length` 后缀进一步降低碰撞。可接受。

---

## 优先级表格

| # | 严重度 | 模块 | 问题 | 建议 |
|---|---|---|---|---|
| 1 | ⚠️ 中 | aiTools/EnhancedScreenshotApp | summarizeRegion 用原图裁剪，打码后仍可还原文字（隐私漏洞） | 改用 getMergedImageDataUrl 合成图裁剪，或检测区域已打码时返回提示 |
| 2 | ⚠️ 中 | AIPanel/aiStore | attachImage 只控当前图不控附加图，开关语义与行为不一致 | 取消勾选时应同时移除附加图，或 UI 区分两类开关 |
| 3 | ⚠️ 中 | AIPanel/aiStore | preset.vision=false 时静默丢图，用户勾选"附带截图"却未发 | vision=false 时 disable 附带截图复选框并提示 |
| 4 | ⚠️ 中 | aiStore | 哨兵打码前 OCR 持久化在对话历史/长期记忆（隐私残留） | 哨兵结束后替换对话中 OCR 片段，或提示残留风险 |
| 5 | ⚠️ 中 | aiStore | refine 不走 trimHistoryToBudget，超长 output 触发 400 | refine 增加预算护栏 |
| 6 | ⚠️ 中 | aiStore | saveConversation 把含图 dataUrl 落 localStorage，配额易超限 | 落盘前剥离 images 字段 |
| 7 | ⚠️ 中 | AIPanel | 多截图附加面板用完整 dataUrl 渲染缩略图，DOM 卡顿 | 生成小缩略图渲染 |
| 8 | ⚠️ 中 | bridge | callTool 的 listen/emit 竞态，快速工具可能 15s 超时 | 先 await listen 再 emit |
| 9 | ⚠️ 中 | toolCallParser | ReAct 正则不支持嵌套 JSON 参数（静默丢弃） | body 匹配改用 findBalancedJsonEnd |
| 10 | ℹ️ 低 | aiTools | drawArrow/drawCallout 坐标未 round，亚像素偏差 | 统一走 normToPx |
| 11 | ℹ️ 低 | ocrClean | cleanOcrTextWithStats 统计与清洗顺序不一致 | 统计在清洗后文本上做 |
| 12 | ℹ️ 低 | toolCallParser | looksLikeShapedToolCall 粗筛误报（hasToolShape 兜底） | 可接受 |
| 13 | ℹ️ 低 | zipStore | zip 仅含缩略图不含原图；dataUrlToBytes 不支持 SVG | 可接受 |
| 14 | ℹ️ 低 | zipStore | zip 文件时间用打包时刻而非会话时间 | 可接受 |
| 15 | ℹ️ 低 | aiStore | refine 不携带截图/OCR 上下文（设计权衡） | 可接受 |
| 16 | ℹ️ 低 | aiStore | convHash 只取前 1024 字符（碰撞概率极低） | 可接受 |

---

## 附：六大功能真实性确认（逐条回应审计重点）

1. **「附带截图」是否真发图给模型？** → ✅ 真发图。aiClient.ts L65-74 构建 `content: [{type:'text'}, {type:'image_url', image_url:{url}}]`，Anthropic L110-121 构建 `image` source。非"只提文字"的假实现。
2. **OCR 是否真附带？** → ✅ 真拼进 prompt。aiPresets.ts L29-33 `withOcr` 把 OCR 包在 `"""..."""` 注入 user 消息。
3. **润色是否真调 AI？** → ✅ 真二次调。aiStore.ts L977 `streamChat`，流式展示。
4. **坐标转换正确性？** → ✅ 三处 normToPx 一致（EnhancedScreenshotApp L36 / EditorWindow L41 / RemoteToolHost L33），`Math.round(clamp01 * W)`。
5. **隐私哨兵：编辑后重 OCR？** → ✅ 真重跑。refreshAiVision（L2268-2276）对合成图重新 `ocr_image`。但 summarizeRegion 用原图是漏洞（见 #1）。

