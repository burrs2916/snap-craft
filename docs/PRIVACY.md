# SnapCraft 隐私政策

> **最后更新**:2026-07-18
> **生效日期**:2026-07-18
> **适用范围**:SnapCraft for macOS(本机应用)
> **联系邮箱**:privacy@snap-craft.app
> **联系地址**:SnapCraft Lab, 123 Example St, San Francisco, CA 94102, USA
> **在线版本(中英双语同页切换)**:`/privacy.html`(M1.5 起支持中英 EN 切换器,见 public/privacy.html 顶部按钮)

---

## 1. 我们的承诺(简明版)

**SnapCraft 不收集、不上传、不追踪您的任何数据。**

- ❌ **不上传截图**:您截取的图片永远留在您的 Mac 上,不会发送到任何服务器
- ❌ **不写遥测**:我们不集成任何分析 SDK、不发送"使用统计"、不打"事件埋点"
- ❌ **不读剪贴板无授权**:除您主动点"复制到剪贴板"外,程序不主动访问剪贴板
- ❌ **不持续联网**:除您启用 AI 助手并发起请求外,程序不主动连接任何远程服务器
- ✅ **零默认联网**:首次启动后,除非您主动开启 AI 助手并填入 API 端点,程序完全离线运行
- ✅ **所有数据本地**:截图、历史、配置、AI 预设都存在 `~/Library/Application Support/com.snap-craft.app/`

---

## 2. 我们收集哪些数据?

### 2.1 默认情况下(零数据收集)

安装并启动 SnapCraft 后,在您**不进行任何额外操作**的前提下:

| 数据类型 | 是否收集 | 存储位置 |
|---------|---------|---------|
| 截图内容 | ❌ 不收集 | 本地磁盘(您选择的位置) |
| 截图历史 | ❌ 不收集 | 本地 `~/Library/Application Support/com.snap-craft.app/history/` |
| 标注 / 编辑内容 | ❌ 不收集 | 与截图同位置 |
| OCR 识别结果 | ❌ 不收集 | 仅显示在 UI 上,不持久化除非您主动保存 |
| 使用统计 / 崩溃日志 | ❌ 不收集 | — |
| 设备标识(UDID / IDFA) | ❌ 不收集 | — |
| IP 地址 | ❌ 不收集 | — |
| 浏览器 / 应用使用记录 | ❌ 不收集 | — |
| Cookies / Tracking Pixel | ❌ 不收集 | — |

### 2.2 您主动启用 AI 助手时

SnapCraft 包含一个内置 AI 助手,用于把截图转换为文档(Markdown / DOCX / PPTX / XLSX / HTML / PDF)。
**默认关闭**。在您主动启用并配置前,此功能完全休眠。

启用 AI 助手需要您:
1. 在「设置 → AI 助手」中填入 **API 端点**(`https://api.openai.com/v1` 或您自部署的 `http://localhost:11434/v1`)
2. 填入 **API Key**(OpenAI / Anthropic / 自部署服务的 key)

之后,当您点击「生成文档」时:

- **发送内容**:您当前截取的图片(base64 编码)+ 您的提示词文本
- **发送目的地**:**仅限您配置的 API 端点**(我们不代理)
- **存储位置**:OpenAI / Anthropic / 自部署服务各自的隐私政策管辖
- **我们是否能看到**:**不能**。我们既不代理您的请求,也不记录您的 Key

**我们建议**:
- 法务/合规/医疗/金融等敏感场景:使用**本地自部署模型**(Ollama / LM Studio / vLLM),数据完全不出本机
- 一般场景:使用 OpenAI / Anthropic 等云端服务时,需同意对方隐私政策

### 2.3 错误反馈(可选,默认关闭)

SnapCraft 不内置"自动上报崩溃"功能。若您主动选择"反馈问题":
- 您需要手动点击"打包日志"按钮
- 打包内容:`logs/dev.log`(脱敏后,不含截图)
- 您需手动选择"通过邮件发送"或"上传到 GitHub Issue"
- **我们不主动接收**;这是您主动发起的操作

### 2.4 Apple 系统级数据

macOS 自身会记录应用使用统计(在「系统设置 → 隐私与安全性 → 分析与改进」中控制),这属于系统级,与 SnapCraft 无关。

---

## 3. 沙箱与权限

SnapCraft 启用了 macOS **App Sandbox**(强制要求,所有 Mac App Store 应用必须),权限范围:

| 权限 | 用途 | 是否必需 | 关闭后果 |
|------|------|---------|---------|
| **屏幕录制**(Screen Recording) | 截取屏幕 | ✅ 必需 | 无法截图 |
| **网络出站** | AI 助手调用 | ⚠️ 可选 | AI 助手不可用,但截图功能正常 |
| **用户选择的文件** | 保存截图到您选的位置 | ✅ 必需 | 无法保存 |
| **下载文件夹** | 默认保存到 ~/Downloads | ✅ 必需 | 需每次选保存位置 |
| **完全磁盘访问** | — | ❌ 不需要 | — |
| **辅助功能** | 全局快捷键 | ❌ 当前不需要 | — |
| **摄像头** | — | ❌ 不需要 | — |
| **麦克风** | P1 录屏音频 | ❌ 当前不需要 | — |

**TCC 撤销机制**:macOS 可能在系统升级或用户清理时自动撤销授权,这是系统行为,您可在「系统设置 → 隐私与安全性」中重新开启。

---

## 4. 数据存储

### 4.1 本地存储路径

| 数据类型 | 路径 | 加密 |
|---------|------|------|
| 应用配置 | `~/Library/Application Support/com.snap-craft.app/config.json` | ❌ |
| 截图历史索引 | `~/Library/Application Support/com.snap-craft.app/history/index.json` | ❌ |
| 历史图片 | `~/Library/Application Support/com.snap-craft.app/history/YYYY-MM/<uuid>.png` | ❌ |
| 钉图元数据 | `~/Library/Application Support/com.snap-craft.app/pin/` | ❌ |
| 诊断日志 | `~/Library/Logs/com.snap-craft.app/dev.log` | ❌(可手动清理) |
| 临时文件 | `/tmp/snapcraft-ai/` | ❌(系统定期清理) |

### 4.2 数据保留

- **历史图片**:保留直到您主动删除(单张删除 / 一键清空)
- **配置**:保留直到您卸载 App
- **诊断日志**:保留 7 天(滚动覆盖)
- **卸载时**:macOS 自动删除 `~/Library/Application Support/com.snap-craft.app/`,但**不删除** `~/Downloads/` 中您已导出的截图

### 4.3 加密

- ✅ 全盘加密(FileVault):若您启用了 macOS FileVault,所有数据自动加密
- ❌ 应用内额外加密:当前不启用(无密钥管理需求,本地无敏感数据)

---

## 5. 用户权利(GDPR / CCPA)

无论您身处欧盟(EU)、美国加州(CA)还是其它地区,您拥有以下权利:

| 权利 | 实现方式 |
|------|---------|
| **访问权**(查看我们有什么) | 所有数据都在您的 Mac 上,无需联系我们 |
| **更正权**(修改) | 直接编辑 `config.json` 或 UI 设置 |
| **删除权**(被遗忘) | 卸载 App + 删除 `~/Downloads/` 导出文件 |
| **数据可携带**(导出) | 用 macOS Finder 直接复制 `~/Library/Application Support/com.snap-craft.app/` 到 U 盘 |
| **反对自动化决策** | 无(我们不做任何自动化处理) |
| **投诉权** | 联系您当地的数据保护机构(DPA) |

**SnapCraft 不持有您的任何数据副本**,所以"数据导出"和"数据删除"实际上是同一件事——您控制 Mac 上的文件。

---

## 6. 儿童隐私(COPPA)

SnapCraft 不面向 13 岁以下儿童,不收集任何年龄相关信息。若您发现您的孩子在未经同意下使用了 SnapCraft,请联系我们,我们会协助处理。

---

## 7. 第三方服务

SnapCraft 自身**不集成**任何第三方分析、崩溃上报、广告 SDK。但您可能通过 AI 助手间接使用:

| 服务 | 何时使用 | 隐私管辖 |
|------|---------|---------|
| OpenAI API | 您在设置中填了 OpenAI 端点 | [OpenAI 隐私政策](https://openai.com/privacy) |
| Anthropic API | 您在设置中填了 Anthropic 端点 | [Anthropic 隐私政策](https://www.anthropic.com/privacy) |
| 自部署服务(本地) | 您填了 `http://localhost:*` | 不出本机 |

**我们不代理、不缓存、不记录**这些调用。直接连您配置的端点。

---

## 8. 国际数据传输

默认情况下,**没有**数据跨境传输(因为默认不联网)。

仅当您:
- 启用了 AI 助手 + 配置了海外 API(OpenAI 在美国、Anthropic 在美国)
- 主动"反馈问题"并选择上传到 GitHub Issue(GitHub 在美国)

时,才会有数据传输。这些操作完全由您主动发起,且目的地都是您选择的。

---

## 9. 安全措施

- ✅ App Sandbox 隔离(系统强制)
- ✅ Hardened Runtime(防止动态代码注入)
- ✅ 公证(Notarization)(确保二进制未被篡改)
- ✅ 私有 API 检测(Apple 自动扫描)
- ❌ 端到端加密:不适用(无云端数据)
- ❌ 双因素认证:不适用(无账号系统)

---

## 10. 政策变更

- 政策变更会在 SnapCraft 启动时弹出提示
- 重大变更(数据收集方式变化)需您主动确认
- 历史版本:见 [CHANGELOG-PRIVACY.md](./CHANGELOG-PRIVACY.md)(如适用)

---

## 11. 联系我们

| 渠道 | 联系方式 |
|------|---------|
| 邮箱 | privacy@snap-craft.app |
| GitHub Issues | https://github.com/liwenchao/snap-craft/issues |
| 邮件(慢) | SnapCraft Lab, 123 Example St, San Francisco, CA 94102, USA |

**响应时间**:7 个工作日内首次回复。

---

## 12. 许可

本文档基于 [Terms of Service; Didn't Read](https://tosdr.org/) 精神撰写,采用 CC BY 4.0 许可,欢迎借鉴。

---

> **TL;DR**:**SnapCraft 不收集您的任何数据。截图永远在您本机。AI 助手只在您主动配置后才联网,且只连您指定的端点。我们看不到、也不想知道您截了什么。**
