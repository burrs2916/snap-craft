# SnapCraft 跨平台功能对等（Parity）测试策略

> 作者：Tessa（testing-expert） · 阶段：仅策略规划，不含测试代码
> 范围：snap-craft（Tauri 2，macOS / Windows）编译产物功能对等验证
> 代码依据：`src-tauri/src/commands/{capture,ocr,permission,edit}.rs`、`lib.rs`、`capabilities/default.json`、`tauri.conf.json`、`.github/workflows/build.yml`、`tests/smoke_macos.sh`

---

## 0. 架构现状与对等风险地图（来自代码审查）

两平台**命令契约（Rust `#[tauri::command]` 签名）一致**，但**实现机制完全分叉**（`#[cfg(target_os = "macos")]` vs `#[cfg(not(target_os = "macos"))]`）。这是一切对等风险的根源。

| 能力 | macOS 实现 | Windows 实现 | 对等风险 |
|---|---|---|---|
| 全屏/区域/窗口截屏 | `screencapture` CLI（`-x`/`-i`/`-w`）+ CoreGraphics | `xcap` crate（底层 Graphics Capture / DXGI 桌面复制） | **高**：两套完全不同的像素后端，边界行为不同 |
| 显示器枚举 | `CGGetActiveDisplayList` + backing pixels（真实物理像素/scale） | `xcap::Monitor::all()`（物理像素 + scale_factor） | 中：坐标/scale 语义需对齐 |
| 窗口枚举/点选 | 系统原生 `-w` 交互取窗 | `list_windows` + `capture_window_by_id`（xcap，前端覆盖层） | **高**：交互模型完全不同 |
| OCR | Apple Vision（`apple-vision` crate，`lang` 被忽略） | WinRT `Windows.Media.Ocr`（PowerShell 5.1 子进程，`lang` 生效，缺语言包报 `NO_OCR_ENGINE`） | **高**：两引擎结果不同，仅契约可对等 |
| 写图到剪贴板 | `osascript` `«class PNGf»` | `arboard` 设 RGBA | 中：粘贴后格式/透明度可能不同 |
| 读剪贴板 | `arboard`（加 NSPasteboard Mutex） | `arboard` | 低：共用同一库 |
| 权限检测 | 真实 TCC（屏幕录制/麦克风/辅助功能） | 当前 **stub**：`check_microphone_access`/`check_accessibility_access` 返回 `false` | **高**：Windows 前端分支从未被真实验证 |
| 全局快捷键 | 同时注册 `SUPER` 与 `CONTROL`；macOS 显示 `⌘⇧` | 同上；Windows 上 `SUPER` 组合预期失败，显示 `Ctrl+Shift` | 中：误报/漏报告警风险 |
| 系统托盘 | `icon_as_template(true)` + 独立模板图标；菜单 accelerator 分平台 | 普通托盘图标；accelerator 分平台 | 中：图标渲染/菜单行为 |
| 关闭→隐藏 | macOS 全屏态用 `minimize()` 替代 `hide()` 规避 macOS 26 crash | 直接 `hide()` | 低（Windows 无此分支） |
| 导出（docx/pptx/xlsx/html/pdf/md） | 前端 JS 生成 + `save_binary_file`（平台无关字节写）+ `dialog` 插件取路径 | 同左 | **低**：纯逻辑，但落盘路径/OS 对话框不同 |
| 能力 ACL | `capabilities/default.json`（双平台共用） | 同左，但自定义命令 + 动态窗口 label 授权仅在 Windows 真机 invoke 时暴露 | **高（F4 项）** |

**关键结论**：命令层（契约）对等已具备；**像素捕获、OCR、权限、剪贴板、托盘、ACL** 六类是真正的对等验证重点，且多数无法在 macOS 开发机或普通 CI 上验证。

---

## 1. 功能对等验证矩阵

> 一致性要求分三档：
> - **契约一致**：输入输出结构/类型一致（允许引擎结果不同）。
> - **行为一致**：用户可见行为一致（快捷键能触发、导出能打开、权限引导可达）。
> - **内容一致**：产出像素/文件在合理容差内等价（golden baseline）。

| # | 功能 | macOS 验证方式 | Windows 验证方式 | 一致性要求 | 优先级 |
|---|---|---|---|---|---|
| 1 | 启动 & 框架就绪 | 真机/CI 启动，主窗口出现、无 panic、`dev.log` 无 error | 真机启动（需真实桌面会话）；CI 仅能验证构建产物存在 | 行为一致（启动即稳定） | **P0** |
| 2 | 全屏截屏 `capture_screen` | 真机（需 TCC 权限）；CI 无法（无屏幕录制授权） | **真机**（需真实显示；无头 CI 截不到/黑屏） | 内容一致：PNG 尺寸=主屏物理像素、非全黑、非空白、>1KB | **P0** |
| 3 | 区域截屏 `capture_region` | 真机：系统原生 `-i` 十字选区 | 真机：前端覆盖层选区 → xcap 全局物理像素 | 行为一致（选区交互不同但结果等价）；内容一致 | **P0** |
| 4 | 窗口截屏 `capture_window` | 真机：系统原生 `-w` 点窗 | 真机：`list_windows`+`capture_window_by_id` 点选 | 行为一致；内容一致（目标窗口像素） | **P0** |
| 5 | 滚动长截图 `capture_region_fixed` + 拼接 | 真机：固定矩形重复截 + `stitch.ts` | 真机：同 xcap 固定矩形 | 行为一致；拼接后高度≈各帧之和 | **P1** |
| 6 | 多显示器枚举 `list_displays` | 真机（多屏）：CGDisplayID + backing pixels | 真机（多屏）：xcap `Monitor::all()` | 契约一致：列表数=显示器数；主屏标记；物理像素正确 | **P1** |
| 7 | HiDPI / scale 一致性 | 真机：Retina/缩放屏 backing pixels | 真机：不同 scale 显示器混合 | 内容一致：scale 计算正确，截图不丢清晰度（1x/2x） | **P1** |
| 8 | OCR 文字识别 `ocr_image` | 真机 + **macOS CI 可跑 Vision**（给定固定图） | 真机（需 WinRT + 可能语言包）；CI 难跑 | 契约一致：返回 `text`+`blocks`；每 block `x/y/w/h ∈ [0,1]`；中文图两平台都抽到中文 | **P0** |
| 9 | OCR 语言参数 `lang` | 真机：确认 `lang` 被**忽略**（仅 macOS 限制） | 真机：确认 `lang` **生效**；缺包走 `NO_OCR_ENGINE` 分支 | 行为一致：macOS 静默忽略、Windows 生效且缺包有引导 | **P1** |
| 10 | 复制到剪贴板 `copy_to_clipboard` | 真机：粘贴到预览验证 PNG 到位 | 真机：粘贴验证 | 行为一致：粘贴后为可用位图 | **P1** |
| 11 | 从剪贴板读图 `read_clipboard_image` | 真机：复制图片文件/位图后读取 | 真机：同 | 契约一致：`ERR_EMPTY`/`ERR_TEXT_NOT_IMAGE` 等令牌；大图≤3000px 缩放 | **P1** |
| 12 | 保存本地 `save_screenshot`/`save_binary_file` | 真机：dialog 取路径落盘 | 真机：同 | 行为一致：文件落盘、路径合法 | **P1** |
| 13 | 导出 6 格式（md/docx/pptx/xlsx/html/pdf） | 真机 + **CI dry-run（已有 `smoke-export.mjs`）** | 真机 + CI dry-run（需加 Windows 等价 job） | 契约一致：文件可被目标程序打开；结构一致（docx 以 `PK` 开头、含 `[Content_Types].xml`） | **P0** |
| 14 | 全局快捷键注册/触发 | 真机：⌘⇧1~4 触发对应 capture 事件 | 真机：Ctrl+Shift 1~4；验证无 `shortcut-register-failed` 误报 | 行为一致：能触发；注册失败不误告警 | **P1** |
| 15 | 系统托盘 & 菜单 | 真机：图标显示、左键菜单、4 个 capture 项 emit 事件 | 真机：托盘图标/菜单/左键行为 | 行为一致：菜单项可达、事件正确 | **P1** |
| 16 | 关闭→隐藏到托盘 | 真机：含 macOS 全屏态（minimize 防 crash） | 真机：普通 hide；验证 `editor-*` 子窗关闭 | 行为一致：关闭不退出进程 | **P1** |
| 17 | 权限检测/引导 UI | 真机：屏幕录制真实布尔；`open_screen_recording_settings` 跳 deeplink | 真机：**麦克风/辅助功能 stub 返回 false** → 前端须显示「暂不支持」而非崩溃；`ms-settings:` deeplink | 行为一致：分支不崩、引导可达 | **P1** |
| 18 | 历史记录持久化 `history` | 真机 + 单测（JSON 原子写/`serde(default)` 兼容） | 真机 + 单测 | 契约一致：增删查清空；旧 history.json 兼容 | **P2** |
| 19 | Pin 窗口（always-on-top） | 真机：浮窗置顶/拖拽/缩放 | 真机：同 | 行为一致 | **P2** |
| 20 | 主题（light/dark/follow-system） | 真机：无 FOUC 首屏 | 真机：同 | 行为一致 | **P2** |
| 21 | i18n 文案一致性 | CI 现有 key 数差异 <5% 校验 | 同（CI 跨平台共用） | 契约一致：key 覆盖一致 | **P2** |
| 22 | AI 窗口/temp file 跨窗传输 | 真机 + 单测（防目录穿越） | 真机 + 单测 | 契约一致：`save/read_temp_file` 文件名安全 | **P2** |
| 23 | 自定义命令 + 动态窗口 ACL | CI lint（`default.json` 校验） | **真机 invoke 验证**（F4 项） | 行为一致：所有 label（`main`/`pin-*`/`region-overlay`/`window-overlay`/`editor-*`/`ai-panel`）被能力授权 | **P0（风险项）** |

---

## 2. 真机验证缺口清单（macOS 开发机无法验证）

> ⚠️ **头号约束**：GitHub `windows-latest` 与 `macos-latest` 均为**无头（headless）** runner。
> - Windows 无头：xcap 的 Graphics Capture / DXGI **需要真实桌面会话 + 显示器**，否则截黑/失败。
> - macOS 无头 + 无 TCC 屏幕录制授权：截图授权弹窗无法交互，`screencapture` 必失败。
> 因此**像素级截屏在两平台 CI 都无法验证**，必须依赖真机巡检。

| 缺口 | 为什么 macOS 机/普通 CI 测不了 | 必须由谁/何环境验证 |
|---|---|---|
| **G1** Windows 真实像素截屏（全屏/区域/窗口/滚动） | xcap 依赖 Windows 显示会话；无头 CI 黑屏 | **Windows 真机**（或自托管带登录会话+显示器的 runner） |
| **G2** Tauri 2 能力/ACL 授权（F4：自定义命令 + 动态窗口 label 授权） | `capabilities/default.json` 的运行时拒绝只在 Windows 真机构建 invoke 时暴露；CI 只能查 JSON 合法性 | **Windows 真机构建**逐条 invoke 验证 |
| **G3** Windows Graphics Capture / DXGI 桌面复制行为 | 同上，属 xcap 底层，需真实驱动/合成器 | Windows 真机（含全屏游戏/UWP/屏保/DWM 保护窗口边界） |
| **G4** SmartScreen 拦截（未签名/自签名 exe/msi 首次运行警告） | 需要真实发布 + 声誉积累 + 真实 Windows | 发布后 **Windows 真机**；CI 无法模拟 |
| **G5** Windows 全局快捷键冲突（Ctrl+Shift 与输入法/其他软件） | 需要真实前台焦点 + 其他常驻软件 | Windows 真机 |
| **G6** Windows 托盘图标渲染/多 DPI/左键菜单 | 需要真实 Explorer 会话 | Windows 真机 |
| **G7** Windows 权限引导 deeplink（`ms-settings:privacy-microphone` 等） | 需要真实 Windows 设置面板 | Windows 真机 |
| **G8** Windows OCR 语言包缺失路径（`NO_OCR_ENGINE`）+ 多语言包安装后行为 | 需特定 WinRT 语言包 | Windows 真机（按所需语言装包） |
| **G9** Windows 窗口枚举/点选覆盖层（`list_windows` 过滤自身/最小/零尺寸、z 序） | 需要真实多窗口桌面 | Windows 真机 |
| **G10** WebView2 Runtime 缺失/引导（Windows 首次运行若缺运行时） | 需要干净 Windows + 无 WebView2 | 干净 **Windows VM/真机** |
| **G11** 多显示器 DPI 混合（Windows 不同 scale 屏拼接、负坐标） | macOS 用 CoreGraphics 全局坐标，机制不同 | Windows 真机（混合 DPI 多屏） |
| **G12** 安装器（MSI/NSIS）行为 + 自更新/协议 | 需要真实安装会话 | Windows 真机 |
| **G13** Windows 关闭→隐藏（`editor-*` 子窗关闭不退出） | 无 macOS 全屏分支但需验证 hide 行为 | Windows 真机 |
| **G14** 麦克风/辅助功能 stub 的前端分支（当前返回 false） | macOS 走真实 TCC，Windows stub 分支从未真实验证 | Windows 真机（确认前端不崩、显示「暂不支持」） |

> 注：任务中提到的 "F4 Tauri ACL 自定义命令授权" 在代码库中未找到明确 "F4" 标识，按上下文解读为 **Windows 侧 Tauri 2 capability/ACL 对自定义命令与动态创建窗口 label 的授权**（对应上表 G2）。建议团队确认 "F4" 是否为内部 feature 编号，如是需补充对应功能到本矩阵。

---

## 3. 自动化测试建议（按 ROI 排序）

> ROI =（风险覆盖 × 跨平台通用性）÷（环境依赖 × 维护成本）。
> 头号设计约束：**CI 只能覆盖"非像素"层**；像素/OCR/剪贴板/托盘/权限引导必须真机巡检。

### ROI-1（最高）：扩展 macOS smoke + 新增 Windows 等价 smoke job
- **做法**：CI 现有 `build.yml` 已有 macOS/Windows **构建矩阵**，但**无功能性 test job**。新增 `test` job（双平台），复用已存在的 `tests/smoke_macos.sh` 思路，增加 Windows 版：`tsc --noEmit`、`cargo check`、`pnpm tauri build` 后启动 app 做**启动冒烟**、导出 dry-run（`smoke-export.mjs` 已是 Node 端、跨平台）。
- **覆盖**：#1 启动、#13 导出、#21 i18n、编译/类型门禁。
- **环境依赖**：低（CI 直接跑，无需显示器）。
- **为何 ROI 最高**：复用现有资产，零新环境，立即把"Windows 完全无测试"变为"Windows 有构建+启动+导出冒烟"。

### ROI-2：平台判定 & 契约单元测试（纯 Rust/Node，零环境依赖）
- **做法**：
  - Rust 单测：`get_platform()` 返回 `macos/windows/linux`；`shortcut_to_event()` 映射（S/1→screen，2→region，3→window，4→scroll）两平台一致；`is_png_near_black` 阈值逻辑。
  - **能力一致性 lint（强烈建议）**：脚本校验 `capabilities/default.json` 的 `windows` 列表 ⊇ 运行时实际创建的 label（`main`, `pin-*`, `region-overlay`, `window-overlay`, `editor-*`, `ai-panel`, **`clipboard-*`**）→ 这是 **G2/F4** 在 CI 的唯一可拦手段。`clipboard-*` 为 code-reviewer 发现的实体化缺口（见 §7），缺失即 CI 失败。
  - **命令对账 lint**：`lib.rs` `generate_handler!` 注册列表 vs 前端 `invoke(...)` 调用名，缺失即告警。
- **覆盖**：#23 ACL lint、#14 快捷键映射、#8/#11 契约边界。
- **环境依赖**：无（CI 全平台跑）。

### ROI-3：导出逻辑跨平台单测（前端 JS，CI 跑）
- **做法**：扩展 `smoke-export.mjs`：对同一份 markdown 在 Node 端生成 6 格式，**断言文件结构**（docx/pptx/xlsx 以 `PK\x03\x04` 开头、含 `[Content_Types].xml` / `ppt/presentation.xml`；pdf 以 `%PDF` 开头；html/md 文本合法），并比对两平台导出产物的**目录结构一致性**（不比逐字节，因时间戳/ID 不同）。
- **覆盖**：#13 导出契约一致。
- **环境依赖**：无。

### ROI-4：OCR 契约单测（macOS CI 可跑；Windows 端需真机）
- **做法**：固定测试图（纯中文/纯英文/中英混排）→ 断言 `ocr_image` 返回 `text` 非空 + `blocks[]` 每项 `x/y/w/h ∈ [0,1]` + `confidence` 区间。**不比对具体文字**（两引擎结果不同）。macOS CI 用 Vision 真跑一张已知图；Windows 端纳入真机巡检（G8）。
- **覆盖**：#8 契约、#9 lang 分支。
- **环境依赖**：macOS 侧 CI 可跑；Windows 侧真机。

### ROI-5：启动冒烟 + 非截屏 IPC 探活（CI，无显示器）
- **做法**：`tauri build` 后启动 app（headless 可启动，因不需要屏幕录制即可起来），通过 stdout/log 或临时暴露的 `get_platform`/`list_displays`（无屏时返回空集但不少崩溃）/`get_history` 等**无副作用命令** invoke 验证进程健康、无 panic。
- **注意**：绝不在 CI 调 `capture_*`/`ocr_image`（会因无权限/无显示失败，噪声大）。
- **覆盖**：#1 启动、#23 命令可达（非截屏类）。

### ROI-6：前端 E2E（Playwright，本地/真机）
- **做法**：对编辑器/标注/导出 UI 跑 Playwright；后端用 mock IPC 替代真实截屏。覆盖标注工具、撤销重做、导出按钮流。
- **覆盖**：#13/#19/#20 前端交互。
- **环境依赖**：中（需真实 WebView；CI 无头 WebView 部分可行，但截图相关需 mock）。

### ROI-7（最低自动化 ROI，但不可替代）：Windows + macOS 真机巡检脚本
- **做法**：真机定时/发布前跑：启动 → 四模式截屏 → OCR → 导出 6 格式 → 剪贴板读写 → 托盘菜单 → 关闭隐藏 → 权限引导。输出通过/失败报告。
- **覆盖**：所有 P0/P1 像素与系统交互项（G1–G14）。
- **环境依赖**：高（需常驻真机/自托管 runner）。**这是唯一能验证 G1–G14 的手段**。

---

## 4. 现有覆盖与缺口识别

**现有覆盖**：
- `tests/smoke_macos.sh`：macOS 编译/类型/6 格式导出 dry-run/AI 核心/截图命令存在性/i18n key 差异/脚本语法/签名/公证 dry-run/M1 必需文件。**纯 macOS，零 Windows，零功能/像素/权限验证。**
- `tests/smoke-export.mjs`：6 格式 Node 端生成 dry-run。
- `build.yml`：typecheck(ubuntu) + cargo-check(macos) + build 矩阵(macos/windows)。**有构建无测试 job。**

**主要缺口**：
1. Windows 平台**完全没有功能性自动化**（仅有构建）。
2. 截屏**像素级断言无基线**（两平台产出 PNG 无 golden 比对）。
3. **capability/ACL 运行时校验缺失**（仅 JSON lint 可补，G2/F4）。
4. **OCR 契约测试缺失**（#8/#9）。
5. 多显示器/HiDPI 专项缺失（#6/#7）。
6. 权限引导分支（Windows stub 返回 false）前端路径**从未验证**（#17/G14）。
7. 托盘/快捷键**无真机测试**（#14/#15）。

**建议覆盖率目标**：
- CI 自动层：编译 / 类型 / 启动 / 非截屏命令可达 / 导出 / i18n / 能力 lint = **双平台 job 100% 覆盖**。
- 真机巡检层：P0 功能（四模式截屏 + OCR + 导出 + 剪贴板 + 启动）= **双平台 100% 手动/自动巡检**。
- 一致性强校验（像素 / 坐标归一化 / 文件结构）= 建 golden baseline，逐步补齐。

---

## 5. 示例测试用例（描述级，非代码）

- **P0-全屏截屏对等**：在两平台真机各截主屏 → 解码 data URL 为 PNG → 断言宽高 = 该显示器物理像素（macOS 用 `display_backing_pixels`；Windows 用 `Monitor` 物理像素），且非全黑（采样非黑像素占比 >1%）、非空白、字节 >1KB。
- **P0-导出 docx 结构对等**：同一份 markdown 在两平台各导出 → 断言文件以 `PK\x03\x04` 开头、可被 `unzip -l` 解出且含 `[Content_Types].xml`，两平台 entry 集合结构一致（忽略时间戳/rels id 差异）。
- **P0-ACL lint（G2/F4）**：解析 `capabilities/default.json` → 断言 `windows` 数组包含 `main`、`pin-*`、`region-overlay`、`window-overlay`、`editor-*`、`ai-panel`、**`clipboard-*`**；任一缺失即 CI 失败（防止 Windows 真机创建窗口被 ACL 拒）。
- **P1-OCR 契约**：固定中文图 → 两平台 `ocr_image` → 断言 `blocks` 非空、每 block `x/y/w/h ∈ [0,1]`、`text` 含中文字符；**不**比对两平台 `text` 是否逐字相同（引擎差异预期）。
- **P1-快捷键无误报**：Windows 真机启动 → 监听 `shortcut-register-failed` 事件 → 断言**未触发**（SUPER 组合在 Windows 注册失败属预期，不应上报告警）；macOS 同理。
- **P1-权限 stub 分支**：Windows 真机调 `check_microphone_access` → 返回 `false` → 前端须渲染「功能暂不支持」且**不崩溃**（验证 #17/G14 的 Windows 分支）。
- **P2-历史兼容**：构造旧版缺 `source`/`annotations`/`ocr_*` 字段的 `history.json` → 加载 → 断言不抛错、不清空、缺失字段走 `serde(default)`。

---

## 6. 给相邻角色的关键提示（协作）

- **SRE/CI（@sre-engineer）**：Windows/macOS CI runner **均为无头**，像素截屏与 OCR 无法在 CI 验证；请在 `build.yml` 增加双平台 `test` job（启动冒烟 + 导出 dry-run + 能力 lint），但**不要**在 CI 调 `capture_*`/`ocr_image`。G1/G3 需自托管带显示器的 Windows runner 或真机巡检。
- **架构（@architect）**：`capabilities/default.json` 的窗口 label 集合必须与运行时动态创建的 label 严格一致（G2/F4）；新增动态窗口时同步更新能力文件，否则 Windows 真机会被 ACL 拒绝。权限命令 `check_microphone_access`/`check_accessibility_access` 在 Windows 仍是 stub（返回 false），前端对应 UI 分支需据此设计。

---

## 7. 静态审查补充的真机专项（code-reviewer 提供，已并入）

以下 5 项由 code-reviewer 从静态审查拆出、其无法定论的**运行时行为**，已并入本策略真机巡检。它们精确对应 §1 矩阵与 §2 缺口，并补充了具体行号与失败注入手法。

| # | 真机专项（code-reviewer） | 代码位置 | 映射本策略 | 验证手法（真机） |
|---|---|---|---|---|
| R1 | **Windows 自定义命令/窗口 ACL 放行** | `capabilities/default.json`（无 `snap-craft:allow-*`）、`acl-manifests.json`（无 app 命令） | G2/F4、#23 | `tauri build` 后开 DevTools，逐个 `invoke` `get_platform`/`capture_screen`/`ocr_image`/`save_screenshot` 等，确认不报 `not allowed by ACL`；并**实际触发**区域/窗口截屏以创建 `region-overlay`/`window-overlay`/`editor-*`/`ai-panel`/`pin-*` 动态窗口，确认创建不被 ACL 拒。 |
| R2 | **`get_platform` 返回值与失败回落** | `EnhancedScreenshotApp.tsx:973` | #23、新增边缘用例 | 确认 Windows 返回 `"windows"`；临时移除权限使 `invoke` 失败，确认前端**不** fail-open 到 `'macos'`（否则 Windows 会错误走 macOS 分支）。 |
| R3 | **OCR 语言包（Windows）** | `ocr.rs` `NO_OCR_ENGINE` 分支 | #8、#9 | 干净 Windows（未装中/英 OCR 语言包）跑 `ocr_image` → 确认报错「系统未安装可用的 OCR 语言包」；macOS 选特定语言确认被静默忽略。 |
| R4 | **Windows 多显示器坐标** | `capture.rs:517` `from_point(0,0)` 假设 + `capture_xcap_region` 单屏截取 + `DisplayInfo.width` 物理/逻辑语义差异 | #6、#7 | 主屏不在原点、跨显示器区域截屏，验证错位/裁剪/坐标；重点查 `DisplayInfo.width` 物理像素 vs 逻辑点语义是否被前端混用。 |
| R5 | **Windows 截屏失败 observability** | `check_screen_capture_access` Win 恒返回 `true` | #17、G14 | 人为让 xcap 失败，确认 PermissionSettings **不**仍显示「已授权」（`true` 会掩盖真实失败）。 |

### R1 实体化实例：`clipboard-ocr` label 缺口（🔴 待 Windows 真机验证）

code-reviewer 已实地核实并将 R1 风险面落到**具体缺口**：运行时创建的窗口 label 全集与 `capabilities/default.json` 的 `windows` 数组逐一核对后，发现
- 数组：`["main","pin-*","region-overlay","window-overlay","editor-*","ai-panel"]`
- 运行时动态 label：`clipboard-ocr`（`src/features/screenshot/components/EditorWindow.tsx:2041` 定义、`#L2060` `new WebviewWindow(label, …)` 创建；`editor-*` glob **不**匹配 `clipboard-` 前缀）→ **不在数组中，无 `clipboard-*` glob 覆盖**。
- 其余 label 均被精确/glob 覆盖。

即 R1 所指的 ACL 风险面已**实体化**：若 Tauri 在 Windows 上按 label 门禁 `allow-create-webview-window`，则「剪贴板取字」窗口在 Windows 真机会被 ACL 拒绝、且前端 `.catch` 静默吞掉（表现「点了取字没反应」）。
- **修复建议（code-reviewer 已提）**：在 `capabilities/default.json` 的 `windows` 数组补 `"clipboard-*"`。
- **交叉定论法（测试可用）**：若 macOS 上「剪贴板取字」窗口能正常创建，则说明 Tauri 实际未严格按 label 门禁（该缺口为良性）；反之若 Windows 真机复现创建失败，即为 🔴 致命缺口，需先补 `clipboard-*` 再发布。

### 测试专家对 R1（F4 ACL）的关键澄清
Tauri 2 的 capability/ACL **不**对 app 自身用 `generate_handler!` 注册的 `#[tauri::command]`（如 `capture_screen`/`ocr_image`）做逐命令门禁——这些命令默认对任何能访问 IPC 的窗口放行。因此 R1 中「命令 invoke 报 not allowed by ACL」的风险**对自定义命令本身偏低**（macOS 能跑已印证）；**真正的 ACL 风险面是 `core:webview:allow-create-webview-window` 与 `core:window:allow-create` 对动态窗口 label 的授权**——若某动态窗口 label 未列入 `capabilities/default.json` 的 `windows` 数组，创建它才会在 Windows 真机被 ACL 拒绝、且前端 `.catch` 静默吞掉（表现「点了没反应」）。
→ **R1 测试应聚焦「触发动态窗口创建」而非仅 invoke 命令**：即在 Windows 真机实际走一遍区域/窗口截屏/编辑器/Pin/AI 面板流程，观察覆盖层与子窗是否真的建出来。

### 新增边缘用例（并入 §5）
- **P0-ACL 动态窗口创建（R1 澄清）**：Windows 真机触发区域截屏 → 断言 `region-overlay` 窗口成功创建且未被 ACL 拒；触发窗口截屏 → `window-overlay` 创建；打开编辑器 → `editor-*` 创建；Pin → `pin-*`；AI → `ai-panel`。任一创建失败即 F4 命中。
- **P0-ACL clipboard-ocr 窗口创建（R1 实体化，🔴 待真机）**：Windows 真机走「剪贴板取字」流程（复制文字/图片后触发取字）→ 断言 `clipboard-ocr` WebviewWindow（`EditorWindow.tsx:2041/2060`）成功创建且未被 ACL 拒。交叉定论：若 macOS 剪贴板取字可用，则说明 Tauri 未严格按 label 门禁（缺口良性）；若 Windows 复现创建失败，为 🔴 致命缺口，需先补 `capabilities/default.json` 的 `"clipboard-*"` 再发布。
- **P1-get_platform 不 fail-open（R2）**：注入 `get_platform` 失败 → 断言前端平台判定**不**回落到 `'macos'`，而是显式错误/降级提示（避免 Windows 走 macOS 专属前端分支）。
- **P1-多显示器坐标（R4）**：主屏不在 (0,0) 的多屏 Windows → 跨屏区域截屏 → 断言输出 PNG 尺寸与所选区域一致、无偏移/黑边；核查 `DisplayInfo` 物理/逻辑字段未被前端误混。
