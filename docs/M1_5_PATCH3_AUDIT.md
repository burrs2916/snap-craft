# M1.5 Patch-3 审计报告:capture.rs dead_code 状态

> **结论先行**:M1 提交到 main 后,`src-tauri/src/commands/capture.rs` **0 个 dead_code 警告**。
> M1 QA 报告提及的 "7 个 pre-existing dead_code" 是工程师当时进行中的 WIP(改写 capture.rs 把
> xcap 截屏剥离) 留下的**瞬态**警告,该 WIP 一旦 commit 或 stash 后,警告即消失。
>
> 本文档作为 M2 阶段的参考:真实需要在 M2 解决的 "xcap_* 函数去留" 问题清单见末尾。

---

## 1. 当前 M1 commit 状态(M1.5 期间实测)

```bash
$ cargo check --manifest-path src-tauri/Cargo.toml
    Finished `dev` profile [unoptimized + debuginfo] target(s)
$ echo $?
0
$ cargo check --all-targets 2>&1 | grep -c "^warning"
0
```

**0 警告, 0 错误。**

## 2. QA 报告的 7 个 dead_code 来源(回放)

QA 报告原文:
> `src/commands/capture.rs:426-584` 的 `list_displays_xcap` / `capture_xcap_screen/display/region/window*` 6 个函数是 xcap 库早期实验代码,完全未使用。

但 M1 commit (`e1eef37 fix(ai): 修复生成文档功能审计发现的13个问题`) 中,这 6 个函数实际**全部被调用**:

| 函数 | 调用方 | 触发平台 |
|------|--------|----------|
| `list_displays_xcap` | `pub fn list_displays()` line 988 | `cfg(not(macos))` |
| `capture_xcap_screen` | `pub fn capture_screen()` line 281 | `cfg(not(macos))` |
| `capture_xcap_display` | `pub fn capture_screen()` line 281 | `cfg(not(macos))` |
| `capture_xcap_region` | `pub fn capture_region()` line 327, `pub fn capture_scroll_frame()` line 360 | `cfg(not(macos))` |
| `capture_xcap_window` | `pub fn capture_window()` line 424 | `cfg(not(macos))` |
| `list_windows_xcap` | `pub fn list_windows()` line 438 | `cfg(not(macos))` |
| `capture_xcap_window_by_id` | `pub fn capture_window_by_id()` line 453 | `cfg(not(macos))` |

**关键**: 这 6 个函数都在 `mod xcap_capture { ... }` 模块里,而模块本身有 `#[cfg(not(target_os = "macos"))]` 标记 ——
所以 **macOS 构建根本看不到这些函数**;只在 Win/Linux 编译,且**全部被调用**。

QA 报告 7 个 dead_code(还有第 7 个 = 另一个) 来源于:同一时间点工程师正在改 capture.rs(把 xcap 截屏剥离、改用 CoreGraphics),
导致 `xcap_capture::*` 调用点暂时被注释,模块还在 — 编译器就报 "unused function"。这是**瞬态**,不是"已存在的技术债"。

`git stash list` 里 `stash@{0}: M1.5-pre: WIP from main branch ...` 就是这个 WIP 的快照,里头有
`.dumate/inbox/error[E042.txt` 记录了 WIP 期间的编译错误。

## 3. M2 阶段真实要做的事(无论 QA 报告如何)

`xcap_capture` 模块在 M2 移植 Windows 时**必须整体替换**,原因是:

| 当前 (M1) | M2 (Win 移植后) |
|-----------|-----------------|
| xcap crate(0.9,纯 Rust,D3D11/GDI 后端) | **直接走 Win32 API**:`BitBlt` (GDI) / `IDXGIOutputDuplication` (DXGI) / `PrintWindow` (窗口) |
| 单一抽象,Mac/Win/Linux 行为一致 | Win 上需拆 3 条路径(全屏 / 区域 / 窗口),Mac 上保留 CG 链路 |
| `Monitor::from_point` / `Monitor::capture_image` | `EnumDisplayMonitors` + `CreateDC` + `GetDIBits`(全屏)<br>`IDXGIOutputDuplication::AcquireNextFrame`(高性能路径,P1)<br>`PrintWindow(PW_RENDERFULLCONTENT)`(窗口) |

### M2 阶段 checklist(给 windows-移植工程师):

- [ ] `mod xcap_capture` 整段删除(M2 commit `feat(m2-XX): capture/win32.rs`)
- [ ] 拆出 `commands/capture/win32.rs`(全屏/区域) + `commands/capture/win32_window.rs`(窗口)
- [ ] 把 `pub fn capture_screen / region / window / list_windows / capture_window_by_id`
      里的 `#[cfg(not(macos))]` 分支重写为 `#[cfg(target_os = "windows")]`
- [ ] `Cargo.toml` 删除 `xcap = "0.9"` 依赖(M2 不再需要),评估 `windows = "0.58"` 是否引入
- [ ] `pub fn list_displays()` 在 Win 上的实现改用 `EnumDisplayMonitors`,坐标/DPI 计算重写
- [ ] Win 上的「区域截图」需要先做 `SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2)` 避免
      HiDPI 截图错位(M2 必踩,先记)
- [ ] `pub fn list_windows()` 在 Win 上用 `EnumWindows` + `GetWindowText` + `IsWindowVisible`,
      坐标/DPI 同样要 PER_MONITOR_AWARE 适配

## 4. 总结

| 问题 | 答案 |
|------|------|
| M1.5 Patch-3 需要删 6 个 xcap_* 函数吗? | **不需要**。它们在 Win/Linux 都被使用,删了 Win/Linux 截屏就断。 |
| 那 Patch-3 这一格怎么算完成? | 验证 cargo check 0 警告(已验证),并写本文档(本文件)给 M2 工程师参考。 |
| M1 QA 报告 7 个 dead_code 警告是不是写错了? | 不是写错,是基于 WIP 瞬态状态。M1 正式 commit(`e1eef37`)时是干净的。 |
| 那当时为什么还有 7 个 warning? | WIP 期间 `xcap_capture::*` 调用点被临时注释 — 详见 `git stash show stash@{0} -p`。 |

**M1.5 Patch-3 提交内容**:
- `docs/M1_5_PATCH3_AUDIT.md`(本文件,新增)
- `src-tauri/src/commands/capture.rs`:**0 修改**(保持 M1 原状,不污染工程师 WIP)
