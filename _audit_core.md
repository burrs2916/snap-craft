# snap-craft AI「生成文档」功能深度审计报告

> 审计范围：`src/features/ai/` 模块（纯前端直连大模型 API，零 Rust）
> 审计重点：生成文档状态流转、流式调用、预设模板、面板交互、Markdown 渲染
> 审计人：audit-core | 日期：2026-07-18 | thoroughness: very thorough

---

## 一、aiStore.ts（状态管理）

### 问题 S1
【问题类型】Bug
【文件】`src/features/ai/aiStore.ts:1119-1123`
【现象】点击「停止」后，`output` 保留流式过程中的部分内容（由 `makeStreamSink` 每 100ms flush 产生），但 `conversation` 中只有被推送的 user 消息，没有对应的 assistant 回复——`finalConv`（含 assistant）从未被 set。导致 output 与 conversation 状态不一致。
```ts
stop: () => {
  abortCtl?.abort();
  abortCtl = null;
  set({ status: 'idle' });   // output 未清，conversation 未补 assistant
},
```
后续若用户切换截图再切回，`setConvKey` 从 conversation 末条 assistant 恢复 output（行 657-658），此时无 assistant 消息 → output 恢复为空，**部分内容静默丢失**。

【根因】`stop()` 仅 abort + 置 idle，未处理「已入队 user 消息但无 assistant 回复」的半成品状态。
【建议】abort 后若 `conversation` 末条为 user 且无 assistant，且 `output` 非空，则把 partial output 作为 assistant 消息补入 conversation 并落盘（标记为「已中断」），保持单一数据源；或显式清空 output 并从 conversation 回退 user 消息。

---

### 问题 S2
【问题类型】Bug / 不达预期
【文件】`src/features/ai/aiStore.ts:782-789`（chat catch 分支）+ `1119-1123`（stop）
【现象】停止生成后，conversation 留下「孤立 user 消息」（无 assistant 回复）。若用户随后点「追问」（handleFollow → chat），`chat()` 读到 `conversation.length > 0` → `isFirst = false`（行 703），于是把这条孤立 user 消息作为历史发回 API，再追加新 user 消息：
```ts
const conv = conversation.slice();      // [{role:'user', content: 上次被中断的 goal}]
const isFirst = conv.length === 0;      // false
// historyMsgs = [{user: 孤立消息}]
// messages = [system, system, {user: 孤立}, {user: 追问}]  ← 两条连续 user
```
对 Anthropic 而言连续两条 user 消息会被合并，模型上下文混乱；对模型而言「用户问了 A（无回答）又问 B」语义割裂，影响追问质量。

【根因】停止后未清理半成品 conversation。
【建议】与 S1 联动修复：停止时要么补 assistant 占位、要么回退 user 消息，使 conversation 始终是「成对 user+assistant」。

---

### 问题 S3
【问题类型】体验缺陷
【文件】`src/features/ai/aiStore.ts:649-669`（setConvKey）
【现象】切换截图恢复成稿时，恢复了 `output` / `conversation` / `memories`，但 **未恢复 `usage` 和 `thinking`**。切换回旧截图后，token 用量显示归零、思考过程卡片消失，用户无法回看上次成本与推理。
```ts
set({
  convKey: key,
  conversation: conv,
  memories: mem,
  activeMemoryIds: [],
  output: restoredOutput,
  error: '',
  status: restoredOutput ? 'done' : 'idle',
  refining: false,
  // 缺：usage / thinking 未恢复（也未清空 thinking）
});
```
【根因】恢复逻辑只覆盖核心文档字段，遗漏了用量与思考过程。
【建议】恢复时 `thinking` 清空（或从 conversation 无法恢复，故清空避免残留），`usage` 保留为上次值或置 0 并标注「历史会话」。

---

### 问题 S4
【问题类型】体验缺陷
【文件】`src/features/ai/aiStore.ts:962-1009`（refine）
【现象】润色指令未写入 conversation。`refine()` 把 `instruction + output` 作为一条 user 消息发给 API，但结果只更新 conversation 末条 assistant（行 986-991），**未追加对应的 user 消息**。导致对话历史丢失「用户要求缩短/转正式」的意图记录，后续追问时模型看不到润色诉求，无法保持一致风格。
```ts
// messages 发给 API：
[
  { role: 'system', content: refineSystem() },
  { role: 'user', content: `${instruction}\n\n${output}` },  // ← 这条没进 conversation
]
// conversation 只改末条 assistant：
if (conv.length && conv[conv.length - 1].role === 'assistant') {
  conv[conv.length - 1] = { role: 'assistant', content: full };
}
```
【根因】设计上把润色当作「就地改写末条成稿」，但丢失了润色指令的历史轨迹。
【建议】将润色指令作为 user 消息补入 conversation（如 `{role:'user', content: instruction}`），再追加新 assistant 成稿，形成完整多轮轨迹。

---

### 问题 S5
【问题类型】体验缺陷
【文件】`src/features/ai/aiStore.ts:673-689`（setOutput）
【现象】面板内二次编辑成稿后 `setOutput` 更新 output + conversation 末条 assistant 并落盘，但 **未更新历史索引**（未调用 `recordConvMeta`）。导致 History 库列表的 `preview` 预览仍显示编辑前的旧内容，用户从历史库看到的是过期预览。
【根因】`setOutput` 只同步 conversation 与落盘，漏了索引刷新。
【建议】`setOutput` 末尾追加 `get().recordConvMeta(get().convKey, st.conversation, activePreset, undefined, '')` 更新预览。

---

## 二、aiClient.ts（AI 调用）

### 问题 C1
【问题类型】不达预期
【文件】`src/features/ai/aiClient.ts:170` + `188`
【现象】`max_tokens` 硬编码为 8192，对 OpenAI 与 Anthropic 两条路径均固定。对于「生成文档」这一**核心功能**，8192 tokens（约 6000 英文词 / 4000 中文字）在生成结构化长文档（PRD、竞品分析、多截图图文报告）时极易**被截断**，且无任何续写机制。
```ts
// Anthropic 分支
const body: any = {
  model: config.model,
  system: systemBlocks,
  messages: cachedRest,
  max_tokens: 8192,        // ← 硬编码，长文档截断
  temperature: config.temperature,
  stream,
};
// OpenAI 分支
const body: any = {
  model: config.model,
  messages: toOpenAiMessages(messages),
  temperature: config.temperature,
  max_tokens: 8192,        // ← 同样硬编码
  stream,
};
```
【根因】max_tokens 未做配置化或按模型能力自适应。部分模型（如 GPT-4o 支持 16k 输出、Claude 3.5 支持 8192）能力不同，固定值偏保守。
【建议】把 max_tokens 提升为可配置项（AiConfig 增字段，默认 8192），或按模型名查表（如 gpt-4o→16384）；长文档场景考虑检测 finish_reason=length 时自动续写。

---

### 问题 C2
【问题类型】体验缺陷
【文件】`src/features/ai/aiClient.ts:510-531`（streamOnce 主循环）
【现象】流式读取无心跳超时检测。`while(true)` 循环持续 `await readAbortable(reader, signal)`，若模型或代理在网络层保持连接但长时间不发数据（如模型思考很久、代理 hang 住），前端会**无限期等待**，既不报错也不给用户进度反馈，表现为「卡死」。
```ts
while (true) {
  const { done, value } = await readAbortable(reader, signal);  // 无超时
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  // ... 帧解析
}
```
仅有用户主动 `stop()`（abort）才能打破。对推理模型（DeepSeek-R1 等）thinking 阶段可能数分钟无正文输出，用户无法判断是「在思考」还是「卡死」。
【根因】缺少 read 超时 / keepalive 检测。
【建议】给 `readAbortable` 加可配置超时（如 90s 无数据则视为 stall，abort 并报错）；或在 thinking 期间持续更新 UI 让用户感知存活。

---

### 问题 C3
【问题类型】Bug
【文件】`src/features/ai/aiClient.ts:477-542`（streamOnce）
【现象】`processFrame` 在遇到内嵌 `json.error` 帧时同步 throw（行 343），该异常从 `while` 帧解析循环中抛出，但此时 `reader` 尚未 `cancel()`。虽然 `readAbortable` 的 abort 路径会 cancel，但**普通错误路径不会 cancel reader**，依赖 GC 回收流。在某些浏览器/代理下可能导致底层 socket 未及时释放。
```ts
while ((frameEnd = findFrameEnd(buffer)) >= 0) {
  const frame = buffer.slice(0, frameEnd);
  buffer = buffer.slice(frameEnd + frameDelimLen(buffer, frameEnd));
  processFrame(frame, ...);   // ← 此处 throw 时 reader 未 cancel
}
```
【根因】错误路径缺少 reader 清理。
【建议】在 streamOnce 的 try/finally 中 `reader.cancel().catch(()=>{})` 确保流释放。

---

### 问题 C4
【问题类型】不达预期
【文件】`src/features/ai/aiClient.ts:699-797`（streamChatWithTools 工具循环）
【现象】工具循环上限为 `maxToolTurns=8`（实际 `turn <= maxToolTurns` 跑 9 轮）。当模型在最后一轮仍调用工具时，工具结果被追加进 messages，但**循环随即结束**，模型再无机会基于工具结果产出最终文档。此时 `fullText` 可能只有工具调用期间的零星文本（甚至为空），用户得到一份**不完整的文档**。
```ts
for (let turn = 0; turn <= maxToolTurns; turn++) {
  const { text, toolCalls } = await streamOnce({...});
  fullText += text;
  if (toolCalls.length === 0) break;   // 正常出口
  // ... 执行工具，追加结果到 messages
  messages.push({role:'assistant', ...toolCalls});
  messages.push({role:'tool', ...results});
  // 循环结束 → 模型没机会基于 results 产出文档
}
```
此外失控循环检测 `MAX_REPEAT_TOOL=3` 触发时只是 `break` 并追加提示（行 784），同样不给模型收尾机会。
【根因】循环结束条件未包含「给模型最后一轮纯文本收尾」。
【建议】到达上限时再发一次 `tool_choice='none'`（或 Anthropic 等价）的请求，强制模型基于已有工具结果产出最终文档。

---

### 问题 C5
【问题类型】不达预期
【文件】`src/features/ai/aiClient.ts:79-125`（toAnthropicMessages）
【现象】Anthropic 路径下，多条 system 消息被合并为一条（行 81-84），这点已修复。但 user/assistant 消息中若**连续出现两条 user**（见 S2 停止后追问场景），Anthropic 会合并为一条，但合并后 content 结构可能混入多模态块导致格式异常。OpenAI 路径则保留两条 user（多数兼容，但部分代理会报错）。
【根因】消息构造侧未保证「user/assistant 严格交替」的不变量。
【建议】在 `toAnthropicMessages` / `toOpenAiMessages` 入口做一次「合并连续同 role 消息」的归一化。

---

## 三、aiPresets.ts（预设模板）

### 问题 P1
【问题类型】不达预期
【文件】`src/features/ai/aiPresets.ts:89-107`（buildReportUser）
【现象】「图文报告」模式在**无任何 OCR 文字**时（`ocrText` 和 `ocrTexts` 均空），`blocks` 为空，但 `intro` 仍要求模型「每张截图对应一节并输出 `<!--SNAP:k-->` 标记」。此时模型只看到图片但没有任何文字锚点提示，对「截图①为当前、②为附加」的序号认知可能错乱，SNAP 标记与实际图片数量的对应关系容易出错。
```ts
const intro = `下面是按顺序排列的多张截图：截图①为当前截图...`;
return `${g ? g + '\n\n' : ''}${intro}${blocks}\n\n请直接输出报告（Markdown，含 <!--SNAP:k--> 标记）。`;
// blocks 为空时，模型只有图片 + 一段纯指令，无 OCR 辅助定位
```
【根因】intro 假设有 OCR 块来锚定每张截图的身份，但无 OCR 时缺少等价的「这是第 k 张图」显式标注。
【建议】无 OCR 时在 user 消息中按顺序显式列出 `[图片1已附上] [图片2已附上]...`，让模型明确图片数量与序号。

---

### 问题 P2
【问题类型】体验缺陷
【文件】`src/features/ai/aiPresets.ts:110-118`（COMMON）+ 各预设 system
【现象】所有内置预设的 system 指令为**中文硬编码**（COMMON 是中文，各 task 也是中文）。当用户界面切换为英文时，发给模型的指令仍是中文，仅靠 COMMON 末句「输出语言应与截图文字一致」兜底。对英文截图，中文指令可能导致模型倾向中文输出或混杂，与英文界面用户的预期不符。
```ts
const COMMON =
  '你是一个擅长把截图内容转化为结构化文档与文案的助手。' +   // 中文硬编码
  '请使用 Markdown 输出，结构清晰、层次分明、可直接使用。' +
  '若截图中含文字，请尽量整合其信息；输出语言应与截图中文字的语言保持一致...';
```
`refineSystem()`（aiStore.ts:81-86）已做了语言自适应，但预设 system 没有。
【根因】预设 system 未做 i18n。
【建议】参照 `refineSystem()` 模式，COMMON 与各 task 指令按 `getLang()` 提供中英双语版本。

---

### 问题 P3
【问题类型】不达预期
【文件】`src/features/ai/aiPresets.ts:237-247`（report 预设）
【现象】`report` 预设的 system 用 `systemWith()`（行 241）包裹，导致 COMMON 与 task 拼接，但 task 文本本身又重复了 SNAP 标记要求。而 `buildReportUser`（行 105）的 intro **第三次**重复了同样的 SNAP 要求。三处重复虽不致错，但冗余指令稀释模型注意力，且若后续修改标记规范需改三处。
【根因】预设 system 与 buildUser 指令职责未清晰分离。
【建议】SNAP 标记契约只在 `buildReportUser` 里定义一次（user 消息），system 只说明「生成连贯图文报告」的高层目标。

---

## 四、AIPanel.tsx（面板交互）

### 问题 A1
【问题类型】不达预期
【文件】`src/features/ai/aiMarkdown.tsx:80-85` + `AIPanel.tsx:1971` / `1999` / `2115`
【现象】**图文报告在应用内不显示截图**。`AiMarkdown` 组件把 `<!--SNAP:k-->` 标记行**过滤掉**（行 85），但**不内嵌对应截图**。导致用户在聊天流 / 流式弹窗里看到的「图文报告」是**纯文字**，看不到图片混排效果——只有导出（mdToHtml / docx / pptx 配合 sectionImages）才能看到图文。
```tsx
// aiMarkdown.tsx —— 过滤标记但不渲染图片
const lines = source
  .replace(/\r\n/g, '\n')
  .split('\n')
  .filter((l) => !/^<!--SNAP:\d+-->\s*$/.test(l));   // 标记被移除，图片丢失
```
对一个「截图 → 图文报告」的核心卖点，用户生成后**在 app 内看不到图文混排**，只能导出才看到，体验割裂。`orderedImages()` 已有图片数据（AIPanel.tsx:697-709），但未传给 AiMarkdown。

【根因】AiMarkdown 设计为零依赖纯文本渲染，未接入图片数据；AIPanel 调用处也未把 sectionImages 传入。
【建议】给 `AiMarkdown` 增加可选 `sectionImages` prop，遇 `<!--SNAP:k-->` 标记时渲染对应 `<img>`（复用 orderedImages）；或在流式输出区增加「图文预览」开关。

---

### 问题 A2
【问题类型】体验缺陷
【文件】`src/features/ai/AIPanel.tsx:675-694`（handleGenerate）
【现象】点「生成」时若已有对话，**无确认地清空** conversation（行 680）。用户多轮打磨后的对话，误点「生成」即丢失，无撤销。
```ts
const handleGenerate = () => {
  setTestMsg(null);
  if (!goal.trim()) return;
  if (conversation.length) clearConversation();   // ← 静默清空，无确认
  // ...
};
```
`handleMakeReport`（行 717）与 `handleAgentRun`（行 745）同样无确认清空。
【根因】把「生成」语义定为「重新起草」，但未保护用户已有投入。
【建议】conversation 非空时弹确认（或自动 fork 一份历史分支再清空），避免误操作丢对话。

---

### 问题 A3
【问题类型】体验缺陷
【文件】`src/features/ai/AIPanel.tsx:1498-1505`（成报告按钮）
【现象】「成报告」按钮的 disabled 条件**未检查 goal 是否为空**：
```tsx
<button
  className="ai-btn ai-btn-report"
  onClick={handleMakeReport}
  disabled={!config.apiKey.trim() || isStreaming || (!imageDataUrl && selectedOrder.length === 0)}
  // ← 缺 !goal.trim() 判断
>
```
而 `handleMakeReport` 内部 `if (!goal.trim()) return`（行 716）静默返回。结果：goal 为空时按钮**看起来可点**但点击无任何反应、无反馈，用户困惑。对比「生成」按钮（行 1489）有 `!goal.trim()` 禁用，行为不一致。
【根因】两处入口的 disabled 条件未对齐。
【建议】成报告按钮 disabled 追加 `|| !goal.trim()`（除非选了图，可允许空 goal 但应给占位提示）。

---

### 问题 A4
【问题类型】体验缺陷
【文件】`src/features/ai/AIPanel.tsx:1936-1949` + `2083-2090`
【现象】「思考过程」以**纯文本**渲染（`{thinking}`），不经过 Markdown 渲染。推理模型（DeepSeek-R1 / Qwen / o-series）的 thinking 内容常含列表、代码、公式等格式，在 app 内显示为带标记的原始文本（如 `**重点**` 直接显示星号）。
```tsx
// 行 1947
{thinkOpen && <div className="ai-think-body">{thinking}</div>}
// 行 2088
<div className="ai-stream-think-body">{thinking}</div>
```
【根因】thinking 直接用 `{thinking}` 文本节点，未走 `AiMarkdown` 或 `renderInline`。
【建议】用 `<AiMarkdown source={thinking} />` 渲染，或至少走 `renderInline` 处理行内格式。

---

### 问题 A5
【问题类型】新需求点
【文件】`src/features/ai/AIPanel.tsx:1480-1538`（操作区）
【现象】无「重新生成」按钮。用户对生成结果不满意时，只能点「清空」重新输入 goal 再生成，或用润色 chips 微调。缺少「用相同 prompt + 截图重新生成一版」的快捷入口（对齐 ChatGPT 的 regenerate）。
【建议】操作区增「🔄 重新生成」按钮，复用上次 goal + preset + 截图上下文重新发起 generate（清空 conversation 后重跑）。

---

### 问题 A6
【问题类型】体验缺陷
【文件】`src/features/ai/AIPanel.tsx:613-624`（popup 自动弹出）
【现象】流式开始时自动弹出全屏弹窗（popupOpen），流式结束后 1.2s 自动关闭。但若用户在弹窗里**正在操作导出/润色**（hasOutput 区，行 2124-2177），1.2s 后弹窗仍会关闭（因为 isStreaming 变 false 触发 setTimeout）。用户还没点完导出按钮弹窗就消失了，操作被打断。
```ts
useEffect(() => {
  if (isStreaming) {
    if (popupPinned || !popupDismissed) setPopupOpen(true);
  } else {
    const t = setTimeout(() => setPopupOpen(false), 1200);  // ← 无条件 1.2s 关
    return () => clearTimeout(t);
  }
}, [isStreaming, popupPinned, popupDismissed]);
```
【根因】关闭策略未区分「用户是否在弹窗内交互」。
【建议】流式结束后若 `hasOutput` 且弹窗内存在导出/润色操作，延长关闭时间或不自动关；或改为「用户点了导出/润色后取消自动关闭」。

---

### 问题 A7
【问题类型】体验缺陷
【文件】`src/features/ai/AIPanel.tsx:1329-1339`（goal 输入框）
【现象】生成后 goal 输入框**不清空**。用户生成完文档后，goal 仍残留，若想换 prompt 生成不同文档需手动清空。而「追问」输入框 follow 在发送后会清空（行 770）。两处输入框行为不一致。
【根因】handleGenerate 未 `setGoal('')`。
【建议】生成成功后清空 goal（或保留以便 regenerate，但需明确的「新对话」入口清空）。

---

## 五、aiMarkdown.tsx（Markdown 渲染）

### 问题 M1
【问题类型】不达预期
【文件】`src/features/ai/aiMarkdown.tsx:93-108`
【现象】**代码块无语法高亮**。团队明确要求审计「代码高亮」，但渲染器把代码块作为纯 `<pre><code>` 输出，**完全忽略语言标识**（```后的 lang），无任何高亮处理。
```tsx
if (line.trim().startsWith('```')) {
  const buf: string[] = [];
  i++;
  while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
  i++;
  blocks.push(
    <pre key={key++} className="md-pre">
      <code>{buf.join('\n')}</code>   // ← 无 lang class、无高亮
    </pre>
  );
}
```
导出路径（markdownHtml.ts:433）虽加了 `class="lang-${esc(lang)}"`，但无 highlight.js 等库，class 无效果。技术文档类预设（tutorial / bug 的代码段）输出在 app 内外均为黑白纯文本。

【根因】设计为「零依赖」纯手写渲染器，未引入高亮能力。
【建议】轻量方案：引入 `highlight.js`（或 `prismjs` 按需语言）对代码块做高亮；或至少把 lang 作为 class 挂上并内置一套基础 CSS 配色（keyword/string/comment 等用正则着色）。

---

### 问题 M2
【问题类型】Bug
【文件】`src/features/ai/aiMarkdown.tsx:85`
【现象】SNAP 标记过滤正则**不容忍空格**：`/^<!--SNAP:\d+-->\s*$/`，而导出路径（markdownHtml.ts:406、markdownDocx.ts:404）用 `/^<!--\s*SNAP:(\d+)\s*-->$/`（容忍空格）。AI 实际输出常带空格（如 `<!-- SNAP:1 -->`，符合 HTML 注释规范），此时：
- **应用内**：标记未被过滤 → 用户在聊天流里看到原始 HTML 注释 `<!-- SNAP:1 -->`
- **导出时**：标记被正确解析 → 截图正常内嵌

两处不一致，应用内显示脏数据。
```tsx
// aiMarkdown.tsx 行 85 —— 不容忍空格
.filter((l) => !/^<!--SNAP:\d+-->\s*$/.test(l));

// markdownHtml.ts 行 406 —— 容忍空格
const marker = /^<!--\s*SNAP:(\d+)\s*-->$/.exec(line.trim());
```
【根因】三处 SNAP 正则未统一。
【建议】抽取统一 `SNAP_LINE_RE`（容忍空格版本），aiMarkdown / markdownHtml / markdownDocx / markdownPptx 全部引用。

---

### 问题 M3
【问题类型】不达预期
【文件】`src/features/ai/aiMarkdown.tsx:116`（标题正则）
【现象】仅支持 H1-H4（`#{1,4}`），不支持 H5/H6。预设如 `bug`（行 186-189）要求 7 个编号小节，若模型用 `#####` / `######` 会被当作普通段落渲染，丢失层级。
```tsx
const h = /^(#{1,4})\s+(.*)$/.exec(line);   // ← 不匹配 ##### / ######
```
【根因】标题正则限制过紧。
【建议】改为 `#{1,6}`，补 h5/h6 渲染分支。

---

### 问题 M4
【问题类型】不达预期
【文件】`src/features/ai/aiMarkdown.tsx`（整体）
【现象】缺少多项 GFM / CommonMark 常用特性：
- **删除线** `~~text~~`：未实现（renderEmphasis 只处理 `**` 和 `*`）
- **图片** `![alt](url)`：未实现（renderInline 的 link 正则不匹配 `!` 前缀）
- **嵌套列表**：无序列表项内子列表未处理缩进，全部拍平
- **自动链接**：裸 URL 未自动转链接
- **脚注 / 定义列表 / 数学公式**：均未实现

`compete` 预设要求 GFM 表格（已支持），`insight` 预设可能产出 `~~删除~~` 标记，渲染器直接显示原标记。

【根因】「零依赖」手写渲染器覆盖子集有限。
【建议】若坚持零依赖，至少补 `~~del~~` 与 `![]()`；或评估引入 `marked` / `markdown-it`（轻量、可按需裁剪）。

---

### 问题 M5
【问题类型】体验缺陷
【文件】`src/features/ai/aiMarkdown.tsx:151-165`（有序列表）+ `194-247`（表格）
【现象】流式过程中每次 100ms flush 都触发 `AiMarkdown` **全量重解析**（整个 source 重新 split + 遍历）。长文档（数千字）下每 100ms 重建一次 React 树，可能造成**卡顿**（尤其低端机）。此外有序列表的序号靠 `<ol>` 自动生成，流式时列表项逐个出现会导致序号跳变。
【根因】渲染器无增量 / 虚拟化；无流式优化。
【建议】流式期间对 `output` 做节流（如 ≥3000 字符时降为 200ms flush）；或对已渲染部分做 memo 缓存（按行 hash 复用已解析块）。

---

## 六、优先级排序问题清单

| 编号 | 优先级 | 类型 | 文件 | 摘要 |
|------|--------|------|------|------|
| C1 | **P1** | 不达预期 | aiClient.ts:170,188 | max_tokens 硬编码 8192，长文档生成被截断，核心功能受限 |
| A1 | **P1** | 不达预期 | aiMarkdown.tsx:85 + AIPanel.tsx | 图文报告在 app 内不显示截图，只过滤标记显示纯文字，图文混排仅导出可见 |
| S1 | **P1** | Bug | aiStore.ts:1119-1123 | stop() 后 output 与 conversation 状态不一致，partial 内容切换后静默丢失 |
| S2 | **P1** | Bug | aiStore.ts:782-789 | stop 后追问发送连续两条 user 消息，模型上下文混乱 |
| M1 | **P1** | 不达预期 | aiMarkdown.tsx:93-108 | 代码块无语法高亮，lang 标识被忽略（团队明确要求审计项） |
| C4 | **P1** | 不达预期 | aiClient.ts:699-797 | Agent 工具循环达上限时无收尾轮，最终文档可能不完整 |
| C2 | **P2** | 体验缺陷 | aiClient.ts:510-531 | 流式无心跳超时，模型长时间不输出时前端「卡死」无反馈 |
| S4 | **P2** | 体验缺陷 | aiStore.ts:962-1009 | 润色指令未写入 conversation，历史丢失润色意图 |
| S5 | **P2** | 体验缺陷 | aiStore.ts:673-689 | setOutput 未更新历史索引，History 预览显示旧内容 |
| A2 | **P2** | 体验缺陷 | AIPanel.tsx:675-694 | 生成/成报告/Agent 无确认清空已有对话，误操作丢失多轮成果 |
| A3 | **P2** | 体验缺陷 | AIPanel.tsx:1498-1505 | 成报告按钮未禁用空 goal，点击无反应无反馈 |
| A4 | **P2** | 体验缺陷 | AIPanel.tsx:1947,2088 | thinking 以纯文本渲染，Markdown 格式标记原样显示 |
| A6 | **P2** | 体验缺陷 | AIPanel.tsx:613-624 | 流式弹窗 1.2s 自动关闭会打断用户导出/润色操作 |
| A7 | **P2** | 体验缺陷 | AIPanel.tsx:1329-1339 | goal 输入框生成后不清空，与 follow 输入框行为不一致 |
| M2 | **P2** | Bug | aiMarkdown.tsx:85 | SNAP 过滤正则不容忍空格，与导出路径不一致，AI 输出 `<!-- SNAP:k -->` 时应用内显示脏注释 |
| M3 | **P2** | 不达预期 | aiMarkdown.tsx:116 | 仅支持 H1-H4，H5/H6 被当普通段落，丢失文档层级 |
| M4 | **P2** | 不达预期 | aiMarkdown.tsx 整体 | 缺删除线/图片/嵌套列表/自动链接等 GFM 特性 |
| M5 | **P2** | 体验缺陷 | aiMarkdown.tsx 整体 | 流式全量重解析，长文档卡顿；有序列表序号流式时跳变 |
| C3 | **P2** | Bug | aiClient.ts:477-542 | streamOnce 错误路径未 cancel reader，依赖 GC 可能泄漏 |
| C5 | **P2** | 不达预期 | aiClient.ts:79-125 | 消息构造未保证 user/assistant 严格交替，连续 user 对部分代理报错 |
| P1 | **P2** | 不达预期 | aiPresets.ts:89-107 | 图文报告无 OCR 时缺少图片序号锚点，SNAP 标记与图片对应易错 |
| P2 | **P2** | 体验缺陷 | aiPresets.ts:110-118 | 预设 system 中文硬编码，英文界面下指令仍为中文 |
| P3 | **P2** | 不达预期 | aiPresets.ts:237-247 | SNAP 标记契约在 system + buildUser 三处重复，维护风险 |
| S3 | **P2** | 体验缺陷 | aiStore.ts:649-669 | setConvKey 恢复时未处理 usage/thinking，切换后成本/推理信息丢失 |
| A5 | **新需求** | 体验缺陷 | AIPanel.tsx:1480-1538 | 无「重新生成」按钮，不满意结果需手动清空重输 |

---

## 七、总体评价

**架构层面**：无空实现、无假实现。代码整体是真实功能，Phase 迭代痕迹清晰（Phase 4/6/9/11/13/14/16/17/18/19/22），错误处理、重试、SSE 解析、记忆压缩、工具循环均有对标顶级项目（openclaw / claw-code / privdoc-ai）的设计注释。

**主要风险集中在「生成文档」核心链路**：
1. 输出长度受限（C1）——长文档截断是功能性硬伤
2. 图文报告 app 内不可视（A1）——核心卖点在应用内体验不到
3. 停止后状态不一致（S1/S2）——影响追问质量
4. 代码无高亮（M1）——技术文档场景不达预期

这四项应优先处理。其余为体验打磨与健壮性增强。
