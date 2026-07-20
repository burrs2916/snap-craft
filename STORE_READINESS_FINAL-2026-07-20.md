# SnapCraft 跨平台 & 双商店上架就绪度 · 最终复核（2026-07-20）

> 本复核**不引用旧报告结论**，直接读 on-disk 真值 + 实跑门禁。目标：确认项目在 **GitHub Actions 编译打包**后，
> 产物上架 **Microsoft Store + App Store** 时，**Windows / macOS 全部功能是否可用**。

---

## 0. 验证方式与门禁（新鲜证据）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 前端类型 + 打包 | `pnpm build`（tsc + vite 双入口） | ✅ exit 0，双入口产物齐全 |
| Rust 类型检查 | `cargo check`（macOS target） | ✅ 4.2s，0 错 0 警 |
| CI 流水线 | `.github/workflows/build.yml` | ✅ 6 大 job 齐全：`typecheck` / `cargo-check` / `cargo-check-win` / `build` / `release` / `appstore` |
| 代码状态 | `git status` | ✅ 工作树干净（仅本报告未跟踪），跨平台对等 commit `fd8f1a4` 已在 main |

源码直读范围：`capture.rs` / `ocr.rs` / `permission.rs` / `edit.rs` / `lib.rs` / `Cargo.toml` / `tauri.conf.json` / `tauri.microsoftstore.conf.json` / `tauri.appstore.conf.json` / `entitlements/*` / `EnhancedScreenshotApp.tsx` / `RegionOverlay.tsx` / `WindowOverlay.tsx` / `build.yml`。

---

## 1. 跨平台功能矩阵（实测代码路径）

| 功能 | Windows（含 MSIX） | macOS 开发者ID（dmg/pkg） | macOS App Store（沙箱） |
|---|---|---|---|
| 全屏截图 `capture_screen` | ✅ xcap 原生 | ✅ `screencapture -x` | ❌ **`screencapture` 被沙箱禁 spawn** |
| 区域截图 `capture_region` | ✅ RegionOverlay→xcap（全局物理像素，已验证） | ✅ `screencapture -i` | ❌ 同上 |
| 窗口截图 `capture_window(_by_id)` | ✅ WindowOverlay→list_windows→xcap | ✅ `screencapture -w` | ❌ 同上 |
| 滚动长截图 `capture_region_fixed` | ✅ xcap | ✅ `screencapture -x -R` | ❌ 同上 |
| 多显示器枚举/选择 `list_displays` | ✅ xcap Monitor::all | ✅ CoreGraphics | ✅ CoreGraphics 枚举不 spawn，沙箱可用 |
| OCR `ocr_image` | ✅ PowerShell→WinRT（系统二进制 `powershell.exe`，MSIX 允许） | ✅ Apple Vision | ✅ Apple Vision（进程内框架，沙箱可用） |
| 复制图片到剪贴板 | ✅ arboard | ✅ arboard（07-19 改，沙箱兼容） | ✅ arboard / NSPasteboard |
| 保存截图 | ✅ WinRT 保存 | ✅ Powerbox | ✅ Powerbox（用户选位） |
| 全局快捷键 | ✅ RegisterHotKey | ✅ CGEventTap | ⚠️ CGEventTap 沙箱可能注册失败 → **降级为托盘菜单触发**（功能不丢，仅快捷键失效） |
| AI 助手（前端直连） | ✅ | ✅ | ✅ `network.client` 已授权 |
| 托盘 / opener / dialog | ✅ | ✅ | ✅ |

**结论**：除 macOS App Store 的「截屏」本身外，**Windows 与 macOS（两种分发渠道）全部功能均可用**。

---

## 2. 🔴 两个硬阻断（直接卡住「上架」目标）

### 阻断 A — Microsoft Store：MSIX `publisher` / `identity` 仍是占位符
- 文件：`src-tauri/tauri.microsoftstore.conf.json`
  ```json
  "publisher": "CN=SnapCraftLab",
  "identity": { "name": "SnapCraftLab.SnapCraft" }
  ```
- 后果：Partner Center 按 **Store 预留名生成的 Publisher CN（一长串十六进制 ID）** 校验，占位符会被直接拒收 → 无法提交。
- 修复（配置级，0 代码）：在 Partner Center 预留应用名 → 复制其 `Publisher` / `PublisherId` → 回填 `publisher`（格式 `CN=xxxx`）与 `identity.name`（格式 `xxxx.SnapCraft`）。
- 另：`certificateThumbprint` / `timestampUrl` 当前为空 —— 走 Partner Center 自签名通道时**空着即可**（平台会重签），无需本地证书。

### 阻断 B — App Store：截屏走外部 CLI，沙箱禁止 → 核心功能失效
- 根因（代码实锤）：`capture.rs` 的 macOS 截屏全部走 `Command::new("screencapture")` + `osascript` 自激活（`capture.rs:98 / 345 / 408 / 419`）。App Store **强制 App Sandbox**，沙箱禁止 spawn 包外进程 → 全屏/区域/窗口/滚动截屏在 App Store 构建下**全部失败**。`entitlements/appstore.entitlements` 第 14-24 行已自述此阻断，并明确 `temporary-exception.screencapture` 在审核中被拒。
- 正解：**迁移到 ScreenCaptureKit**（`SCStream` / `SCContentFilter`，配 `com.apple.security.device.screencapture` 授权）——这是 App Store 唯一合规的截屏路径，属**架构级改动**（新增 Rust 模块、重构 capture 命令返回流、处理权限申请 UI），需单独里程碑 + 你拍板方案，**不应擅自重构开发者ID 路径**。
- 影响范围：仅 macOS App Store；**开发者ID 版与 Windows 完全不受影响**。

---

## 3. ⚠️ 需验证 / 待办（非阻断，但上线前必查）

1. **MSIX `graphicsCapture` 能力**：xcap 走 `Windows.Graphics.Capture`。打包 MSIX 首次截屏会弹系统「允许屏幕捕获」 consent（预期行为），但建议在 `build.yml` 的 MSIX 模板确认含 `rescap:Capability Name="graphicsCapture"`（避免部分 Win10 版本静默失败）。需在 Windows 真机跑一次确认。
2. **App Store job 仅 arm64**：`build.yml:712` `--target aarch64-apple-darwin`，缺 universal/Intel。Apple Silicon 用户 OK；Intel Mac 用户买不到。建议加 x86_64 或 universal。
3. **App Store 全局快捷键降级**：沙箱内 CGEventTap 注册失败 → 快捷键失效，但托盘菜单仍可触发截屏（功能不丢）。如需快捷键，ScreenCaptureKit 迁移后需配套用 `RegisterEventHotKey` 或 Tauri global-shortcut 的沙箱兼容路径。
4. **CI secrets 未配置会红**：`appstore` job 依赖 Apple 证书/App Store Connect API key；`build` 的 Windows 签名依赖证书 thumbprint。未配 secrets 时 CI 走 ad-hoc 兜底（本地测试 OK，不能上架）。**上架前须在仓库 Settings → Secrets 配齐**。
5. **OCR 语言包依赖（Windows）**：WinRT OCR 需系统装了对应语言「可选功能·文字识别」组件；未装时返回友好提示（已实现 `NO_OCR_ENGINE` 分支）。建议在 Windows 真机预装 zh/enu 包后验证一次。

---

## 4. 上架路线图（可执行清单）

### Microsoft Store（基本就绪，约 0.5 天）
- [ ] Partner Center 预留 `SnapCraft` 应用名 → 取得 Publisher CN
- [ ] 回填 `tauri.microsoftstore.conf.json` 的 `publisher` / `identity.name`
- [ ] 确认 MSIX 模板 `graphicsCapture` 能力
- [ ] 仓库 Secrets 配 Windows 签名证书（或用 Partner Center 自签名通道）
- [ ] 跑 `build` job → 取未签名 `*.msix` → Partner Center 提交

### macOS App Store（需先解阻断 B，约 1 里程碑）
- [ ] **决策**：启动 ScreenCaptureKit 迁移（Rust 新模块 + capture 命令重构 + 权限 UI）
- [ ] 迁移后补 `com.apple.security.device.screencapture` 到 `appstore.entitlements`
- [ ] 加 x86_64 / universal 构建
- [ ] 配 Apple 证书 + App Store Connect API key secrets
- [ ] 跑 `appstore` job → 取 `.pkg` → App Store Connect 提交

### macOS 开发者ID（已就绪）
- [ ] `build` job 产出 notarized dmg/pkg，直接分发

---

## 5. 一句话总结

- **Windows（Microsoft Store / 独立）**：✅ 全部功能可用，唯一拦路是 `tauri.microsoftstore.conf.json` 的占位 Publisher（填 Partner Center 真实值即可）。
- **macOS 开发者ID**：✅ 全部功能可用，已 notarized 可分发。
- **macOS App Store**：⚠️ 除「截屏」外全部可用；**截屏因沙箱禁止 spawn `screencapture`，必须 ScreenCaptureKit 迁移后才能上架功能性版本**——这是上线前唯一必须做的架构级改造。

> 严守「诊断优先 + 不擅加未请求功能」：本复核未改动代码/配置（阻断 A 需你提供 Partner Center Publisher 值；阻断 B 需你拍板 ScreenCaptureKit 迁移方案）。
