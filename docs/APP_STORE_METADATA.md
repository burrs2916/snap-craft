# SnapCraft App Store Connect 元数据填写指南

> 目标:让 SnapCraft 0.1.0 在 macOS App Store 上有完整的可被审核通过的元数据。
>
> **预计耗时**:首次填写 2-4 小时(截图 5 张耗时最长)。

---

## 1. 元数据总览

| 字段 | 长度 | 是否必填 | 示例 |
|------|------|---------|------|
| **App 名称** | ≤ 30 字符 | ✅ | SnapCraft — Smart Screenshot |
| **副标题** | ≤ 30 字符 | ✅ | AI-first screenshot & OCR |
| **宣传文本** | ≤ 4000 字符 | ⚠️ 可后续改 | (见 §3) |
| **描述** | ≤ 4000 字符 | ✅ | (见 §3) |
| **关键词** | ≤ 100 字符(逗号分隔) | ✅ | (见 §4) |
| **类别** | 主+次 | ✅ | 主:效率 / 次:图形与设计 |
| **隐私政策 URL** | 必须可访问 | ✅ | https://snapcraftlab.github.io/snap-craft/privacy/ |
| **技术支持 URL** | 必须可访问 | ⚠️ | https://github.com/liwenchao/snap-craft/issues |
| **营销 URL** | 可选 | ❌ | https://snapcraftlab.github.io/snap-craft/ |
| **App 图标** | 1024×1024 PNG,无 alpha | ✅ | icons/1024x1024.png |
| **截图** | 1-10 张 | ✅ | (见 §5) |
| **定价** | USD | ✅ | $9.99(一次性) |
| **可用性** | 全部 / 指定国家 | ✅ | 全部(初始 175 个国家) |

---

## 2. 名称 / 副标题(必填,审核员最关注)

### 2.1 App 名称(30 字符限制)
**首选**:`SnapCraft — Smart Screenshot`
- 字符数:31,需微调
- 改:`SnapCraft · Smart Screenshot`(31 字符,中点·算 2 字符)
- 再改:`SnapCraft - Smart Screenshot`(26 字符 ✅)
- 或:`SnapCraft — Screenshot+`(22 字符 ✅)

**备选**:
- `SnapCraft: AI Screenshot`(22 字符 ✅)
- `SnapCraft Screenshot Tool`(24 字符 ✅)
- 纯 `SnapCraft`(10 字符,最稳妥)

### 2.2 副标题(30 字符限制)
**首选**:`AI-first Screenshot & OCR`(26 字符 ✅)
- 突出"AI"差异化

**备选**:
- `Capture · Annotate · Document`(28 字符 ✅)
- `Editor-grade Screenshot Tool`(28 字符 ✅)

---

## 3. 描述(4000 字符限制,审核员细看)

### 3.1 宣传文本(Promotional Text,4000 字符)
放在描述顶部,可随时更新(无需审核)。

```
🎉 0.1.0 — Initial release on macOS App Store

Capture your screen in one keystroke, annotate with editor-grade tools,
extract text with system-native OCR, and let the built-in AI assistant
turn your screenshots into Markdown, DOCX, PPTX, XLSX, HTML, or PDF
documents — all without leaving the app.

Privacy-first by design:
• Zero telemetry, zero upload of your screenshots
• AI assistant calls only the endpoint YOU configure
• All history stays local in your Application Support folder
```

### 3.2 完整描述(Description,4000 字符)

```
SnapCraft is a privacy-first screenshot tool for macOS that combines
fast capture, editor-grade annotation, system-native OCR, and an
AI assistant — all in one app. Zero telemetry. Zero upload. Your
screenshots never leave your machine unless you explicitly export them.

─── CAPTURE ───
• Full Screen — capture any display, with multi-monitor picker
• Region — interactive crosshair selection
• Window — click any window to capture
• Scrolling — automatic frame stitching for long content
• Global hotkeys (⌘⇧1/2/3/4) for instant capture from anywhere

─── ANNOTATE ───
10 tools: Select · Arrow · Line · Rectangle · Ellipse · Text · Pen ·
Highlighter · Mosaic · Numbered step. 6-color palette, 4 stroke
widths, infinite undo/redo, and privacy masking (mosaic or Gaussian
blur). Konva-powered canvas runs smoothly on 4K+ Retina displays.

─── OCR ───
System-native text recognition via Apple Vision — no third-party
runtime, no JavaScript OCR library, no model download. Recognizes
Chinese, English, Japanese, Korean, and 20+ more languages. Click
once to copy text from any screenshot.

─── AI ASSISTANT ───
Built-in AI panel turns screenshots into documents:
• Markdown — clean notes
• DOCX — Word documents with themes
• PPTX — slide decks
• XLSX — spreadsheets
• HTML — web pages
• PDF — print-ready
The AI remembers your last 10 related screenshots as context, so
"compare this design to the previous one" actually works. AI
endpoint is fully configurable — point it at OpenAI, Anthropic,
a local Ollama, or any OpenAI-compatible API.

─── HISTORY ───
All your captures in one searchable list. Pin any screenshot to
your screen as a floating always-on-top window. Pin survives across
reboots until you close it.

─── PRIVACY ───
• No telemetry. No analytics SDK. No "anonymous usage data".
• No upload. Screenshots stay on your disk in
  ~/Library/Application Support/com.snap-craft.app/
• AI assistant is OFF by default. Enable it in Settings, provide
  YOUR API endpoint and key, and only then does it make outbound
  requests — to a server you chose.
• Full source code transparency: build instructions and
  dependencies are documented in the project repository.

─── macOS NATIVE ───
Built on Tauri 2 + Rust, packaged as a universal binary for
Apple Silicon and Intel. Runs on macOS 14.0+. Optimized for
HiDPI and multi-monitor setups.

If you find SnapCraft useful, please leave a review — it really
helps. If you have a problem, file an issue on GitHub (we read
every one). For privacy questions, see the Privacy Policy link
below.
```

### 3.3 字符数核查
描述总长 ~2300 字符,远低于 4000 限制。✅

---

## 4. 关键词(100 字符限制,逗号分隔,无空格)

**首选**(97 字符):
```
screenshot,OCR,AI,annotation,editor,document,scrolling,capture,PNG,productivity,memo
```

**精简版**(83 字符):
```
screenshot,OCR,AI,annotation,editor,document,scrolling,capture
```

**关键词策略**:
- 高频低竞争:`screenshot`,`capture`,`editor`(基础搜索)
- 长尾精准:`scrolling`(滚动截图强项)、`annotation`(标注差异化)
- AI 概念:`AI`,`OCR`(与"AI 助手"对齐)
- 文档产物:`document`(DOCX/PPTX 卖点)
- 避免堆叠竞品词:`snipaste`,`cleanshot` 等会被 Apple 当作"竞争对比"拒

---

## 5. 截图(必填,5-10 张,决定转化率)

### 5.1 规格(macOS)

| 类型 | 尺寸 | 文件大小 | 命名建议 |
|------|------|----------|---------|
| **必备** | **2880 × 1800**(16:10,MacBook 主流) | ≤ 500 KB | `01-main.png` ... `05-features.png` |
| 可选 | 2560 × 1600(老款 MacBook) | ≤ 500 KB | `legacy-*.png` |
| 可选 | 5120 × 2880(Pro Display XDR) | ≤ 500 KB | `xdr-*.png` |

**最少 5 张,推荐 8 张,最多 10 张**。

### 5.2 5 张基础截图脚本

| # | 标题 | 内容 | 重点 |
|---|------|------|------|
| 1 | 主界面 | SnapCraft 主窗口 + 模式选择 + 多显示器 | 干净的"第一印象" |
| 2 | 区域截图 | 区域选择中,带虚线选择框 + 尺寸提示 | 核心交互 |
| 3 | 编辑器 | 标注画布,画了几个矩形 + 箭头 + 文字 | 编辑器差异化 |
| 4 | OCR 识别 | 截图含英文/中文 + 右侧识别结果 | 系统级 OCR 能力 |
| 5 | AI 助手 | AI 面板 + 6 格式产物选择 + 对话 | AI 差异化 |

### 5.3 截图制作清单

1. **设备**:用真机录(避免设计稿被识别)
   - 推荐:MacBook Pro M3 / 16" (3456 × 2234 屏幕) 缩放至 2880 × 1800
   - 备用:iMac 24" (4480 × 2520) 缩放
2. **环境**:
   - 浅色 + 深色各一组(浅色优先,深色次之)
   - 桌面背景用 Apple 官方默认(`Sonoma` / `Sequoia` 静态图)
   - 时区显示符合目标市场(美/欧/亚洲)
3. **文案**:
   - 标题用大号粗体(`SF Pro Display`,48pt+)
   - 副标题 `SF Pro Text`,24pt
   - 避免中文(英文为主,1 张可加中文)
4. **数据**:
   - 截图中的"内容"要是用户能识别的(浏览器、IDE、Notion 等)
   - 避免敏感信息(账号、密码、个人照片)
5. **后期**:
   - 不要加 App Store 边框或水印
   - 不要加"已上架"或下载链接
   - 角落可加 SnapCraft logo 但要小

### 5.4 自动化建议

```bash
# 把截图缩小到 2880x1800(保持比例)
for f in screenshots/original-*.png; do
  sips -Z 2880 "$f" --out "screenshots/$(basename "$f")"
done

# 批量查看文件大小
ls -lh screenshots/*.png | awk '$5 > 500K {print $NF, $5}'
```

---

## 6. 类别(Category)

| 主类别 | 次类别 | 推荐理由 |
|--------|--------|----------|
| **效率**(Productivity) | 图形与设计(Graphics & Design) | 截屏工具 + 编辑器 + AI 文档 = 效率工具 |
| 摄影(Photo & Video) | 效率 | 次选(若以"截图"为核心) |
| 开发者工具(Developer Tools) | 效率 | 适用于 if 目标用户是开发者 |

**首选**:**效率 / 图形与设计**
- 与 App Sandbox 已声明的 `public.app-category.productivity` 一致
- 审核员归类为"工具"而非"创作",减少 creative 类别严苛审查

---

## 7. 隐私政策(Privacy Policy URL)

**必填**,且 URL **必须可访问**。

### 7.1 准备
- 自建页面(已规划):`public/privacy.html` + 部署到 GitHub Pages
- 临时兜底:写一个简版 markdown 转 HTML,放到 `https://snapcraftlab.github.io/snap-craft/privacy/`
- 严禁内容:不能放示例/无具体声明,Apple 审核员会判定"无意义内容"打回

### 7.2 必备内容(见 `docs/PRIVACY.md` 与 `public/privacy.html`)
- 数据收集 / 使用 / 共享 / 存储 / 用户权利
- GDPR / CCPA 合规声明
- 联系方式(邮箱 + 邮寄地址,审核员可能直接发邮件核验)
- 最后更新日期

---

## 8. 定价(Pricing)

| 字段 | 值 |
|------|-----|
| **价格档** | Tier 10($9.99) |
| **类型** | 一次性买断(One-Time Purchase) |
| **免费试用** | 0(0.1.0 不做试用,1.0 阶段考虑) |
| **内购** | 无(P0 阶段),1.0 可加 Pro 版订阅 |

**对应所有货币**:
- USD 9.99
- CNY 68.00
- EUR 9.99
- JPY 1500
- GBP 7.99

**自动转换**:勾选 "Auto-convert prices based on country" 让 Apple Store 按汇率算。

---

## 9. 地区可用性

**默认**:全部 175 个国家/地区(选 "Make available in all territories")

**特殊处理**:
- 中国大陆:需 ICP 备案(企业开发者),如未做,移除 China
- 俄罗斯:Apple 已停止俄罗斯 App Store 销售
- 朝鲜/伊朗/叙利亚:不提供

---

## 10. 提交前自检清单

- [ ] 所有 5-8 张截图尺寸正确(2880×1800),每张 ≤ 500 KB
- [ ] App 图标 1024×1024 PNG,无 alpha 通道(Apple 拒绝 RGBA)
- [ ] 名称 ≤ 30 字符,副标题 ≤ 30 字符
- [ ] 描述已用纯文本贴入(不要富文本 / 链接 / 表情符号)
- [ ] 关键词 ≤ 100 字符,逗号分隔
- [ ] 隐私政策 URL 可访问且含联系信息
- [ ] 类别选了"效率"
- [ ] 价格档 Tier 10 / 一次性
- [ ] 技术支持 URL 指向 issues 页(可访问)
- [ ] 联系方式(版权页 / iTunes Connect 用户信息)真实可联系

---

## 11. 提交后状态机

| 状态 | 含义 | 行动 |
|------|------|------|
| **Prepare for Submission** | 元数据填完,构建上传完 | 提交 |
| **Waiting for Review** | 已提交,排队审核 | 等待(1-3 天) |
| **In Review** | 审核员正在看 | 等 1-3 天 |
| **Rejected** | 拒了 | 查 review notes,改,再交 |
| **Pending Developer Release** | 过了! | 选"自动发布"或"手动发布" |
| **Ready for Sale** | 已在 App Store 上架 | 完成 ✅ |

---

## 12. 常见问题

### Q1:App 名称已被占用?
A:加前缀/后缀(如"SnapCraft Pro"、"SnapCraft 截屏")。Apple 允许 1 个 App Store 名称跨多个开发者账号,所以"重名"不是冲突原因,是注册优先。

### Q2:截图被 Apple 拒(显示"4.0 Design"违规)?
A:常见原因:
- 截图含 iOS / Android 设备外观(违规 2.3.1)
- 截图含价格信息(违规 2.3.2)
- 截图与 App 实际功能不符(违规 2.3.8,如截图中显示的功能未实现)

### Q3:关键词被拒?
A:不能用竞品商标词(`Snipaste`,`CleanShot`)。Apple 判定为"误导性元数据"。

### Q4:定价档不对?
A:Tauri 1.0 → 必须选 App Store Connect 现成的档位,不可自定义。$9.99 对应 Tier 10。

### Q5:内购项怎么配?
A:0.1.0 不做内购,留空。1.0 加"Pro 订阅"时,在 App 内购买项 → "添加消耗型 / 自动续期订阅"。

---

**参考文档**:
- App Store Connect 帮助:https://developer.apple.com/help/app-store-connect/
- App Store Review Guidelines:https://developer.apple.com/app-store/review/guidelines/
- 截图规范:https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots
