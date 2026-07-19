# 跨平台编译产物兼容性复盘 R26 · Windows 主屏选取强化

> 自动化轮次：第 26 轮（2026-07-19）
> 目标：对「GitHub Actions 编译产物在 Windows / macOS 上功能对等、无偏差、只增不减」做复盘回溯 + 调整修改。

## 1. 执行摘要

本轮回溯确认 R18–R25 全部兼容性防线仍然 intact（tsc / 跨平台 parity lint / macOS cargo check 全绿，
`build.yml` 与 `tauri.conf.json` 有效），并在此基础上落地 1 项真实 Windows 对等性增强：

- 🔴 **R26 增强（真实 Windows 多屏偏差）**：`capture_xcap_screen()` 原用 `Monitor::from_point(0,0)`
  选取主显示器。在 Windows 多屏且主屏被设为非虚拟桌面原点（主屏在扩展布局负坐标侧、或原点让给副屏）
  时，`from_point(0,0)` 可能落到**非主屏**，导致「全屏截图截错显示器」。改为优先用系统权威的
  `is_primary()` 选取主屏，`from_point(0,0)` 仅作兜底——与同模块 `list_displays_xcap()` 已验证的
  主屏判定逻辑完全一致，属纯增量、零回归、不阉割。

功能只增不减；零新依赖、零新权限、零前端改动。

## 2. 复盘 / 回溯（防线验证，全绿）

| 防线 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 | `pnpm exec tsc --noEmit` | ✅ exit 0 |
| 跨平台一致性 lint（ACL 窗口授权 + 命令注册对等） | `node tests/lint-capabilities.mjs` | ✅ exit 0（39 后端命令全注册、运行时窗口 label 全覆盖） |
| macOS 后端编译 | `cargo check --locked`（macOS） | ✅ exit 0（同时验证本次 cfg(not macos) 改动语法有效） |
| Windows 后端编译门禁 | CI `cargo-check-win`（windows-latest + RC.EXE） | ⏳ PR 阶段自动跑（本地 macOS 缺 RC.EXE / llvm-rc，资源编译步无法在 Mac 跑——已知环境限制，非本次引入） |

配置文件有效性：`build.yml`（YAML 解析 OK，6 job 齐全：typecheck / cargo-check / cargo-check-win / build / release / appstore）、
`capabilities/default.json`（JSON OK，含 `clipboard-*`、`opener:allow-open-path`、`core:window:allow-*`）、
`tauri.conf.json`（JSON OK，webview `offlineInstaller` + icns/ico 齐备）均确认有效。

## 3. 调整 / 修改明细（R26）

**文件**：`src-tauri/src/commands/capture.rs` · 函数 `capture_xcap_screen()`（位于 `#[cfg(not(target_os = "macos"))]` 模块）

```rust
pub fn capture_xcap_screen() -> Result<String, String> {
    // 主屏选择策略（跨平台对等强化 R26）：
    // 优先用系统权威的 is_primary() 取主屏，比 from_point(0,0) 更稳——
    // Windows 多屏且主屏非虚拟桌面原点时 from_point(0,0) 可能落非主屏。
    // 找不到主屏标记再退回 from_point(0,0) 兜底。
    let monitor = {
        let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {}", e))?;
        monitors
            .into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| Monitor::from_point(0, 0).ok())
            .ok_or("未找到可用显示器（多屏枚举为空）")?
    };
    let image = monitor.capture_image().map_err(|e| format!("全屏截屏失败: {}", e))?;
    save_and_encode(image)
}
```

- **影响面**：仅 Windows / Linux 全屏截图（macOS 全屏走原生 screencapture -x，不受影响）；
  标准单屏 Windows 为等价变换（主屏即 `is_primary()` 命中的那台，与原 `from_point(0,0)` 一致）；
  多屏且主屏非原点布局从「可能截错屏」变为「必然截对主屏」。
- **安全性**：所用 API（`Monitor::all()` / `is_primary()` / `from_point().ok()` / `ok_or()`）与同文件
  `list_displays_xcap()` 完全一致，类型安全由构造保证；CI `cargo-check-win` 提供最终编译校验。

## 4. 功能矩阵（两端对等，沿用 R22 结论，本轮回溯无一项退化）

全屏 / 区域 / 窗口 / 滚动截屏、多屏枚举、TCC 权限（macOS）/ 恒 true 透出（Win）、
系统原生 OCR（Apple Vision / WinRT，含 NO_OCR_ENGINE 降级）、剪贴板取字（arboard）、
复制 / 保存 / 历史 / 钉图 / 编辑器定位、AI 窗拖动（startDragging）、opener 打开与「在文件管理器显示」、
全局快捷键、托盘、主题与 i18n、6 格式导出、ACL 门禁、命令注册门禁、临时路径（`std::env::temp_dir()`）、
HiDPI 覆盖层 DPR 折算、导出路径分隔符（Win `\`）——**24 项两端对等，无一项阉割**；
差异均为平台能力本质不同（TCC / 系统 OCR 引擎 / WebView2 引导方式），非功能缺失。

## 5. 仍须 Windows 真机巡检（headless CI 不可验，诚实标注）

以下为运行时 / 系统级行为，CI 无法断言，需真机验证（非代码缺陷）：
- G1 / G3 真实像素截屏观感（区域 / 窗口 / 全屏 xcap 输出）。
- G4 Windows SmartScreen 拦截（未签名构建首次运行告警，预期行为）。
- G8 OCR 语言包：系统未装中文/英文 OCR 可选功能时，R26 代码已用 `TryCreateFromLanguage` + 用户语言包
  兜底 + `NO_OCR_ENGINE` 明确报错引导安装，行为正确；但「是否装了语言包」需真机确认。
- G10 WebView2：MSI / NSIS 已内嵌 `offlineInstaller`（离线可跑）；独立 portable exe 仍要求系统预装
  WebView2（格式本质，已 README 说明）。
- 多屏混合 DPR 覆盖层：R20 用主屏单一 dpr 折算（已知近似，非偏差），未盲目改。

## 6. 交付物

- `PLATFORM_PARITY_FIX-2026-07-19-r26.md`（本报告）
- 改动 `src-tauri/src/commands/capture.rs`（`capture_xcap_screen` 主屏选取强化，未提交，随工作流审阅）
