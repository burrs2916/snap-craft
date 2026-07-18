# 全屏截图「黑屏 + 缩放不对」根因修复报告

**日期**：2026-07-13
**现象**：全屏截图黑屏、像素/缩放不对没截全，"之前都好的"。用户确认：**所有屏、整张全黑**。

---

## 结论：两个独立问题，都已修复

| # | 问题 | 性质 | 根因 | 状态 |
|---|------|------|------|------|
| A | 整张全黑（所有屏） | **回归** | 屏幕录制权限漂移（ad-hoc 签名） | ✅ 已修 |
| B | 缩放不对/没截全 | 老问题 | HiDPI 缩放屏 scale 探测错误 | ✅ 已修 |

---

## 问题 A：整张全黑 = 屏幕录制权限漂移（真正的回归）

### 根因链
1. 运行的 dev app 是 **ad-hoc 签名**（`codesign -dvvv` 显示 `Signature=adhoc`）。
2. ad-hoc 签名的 TCC 身份 = 二进制哈希（CDHash），**每次重编就变** → macOS 认为是"不同的 app" → 屏幕录制授权失效。
3. `screencapture` 在**无屏幕录制权限时不报错**，直接返回**全黑 PNG**。这就是"所有屏整张全黑"。
4. 为什么该走证书却回退了 ad-hoc：`SnapCraft Local` 证书的 **identity 已损坏**——`security find-identity -v -p codesigning` 能列出证书名，但实际签名报 **`no identity found`**（证书在、但私钥配对失效，全策略下 `0 valid identities`）。所以 `start.sh` 证书签名失败、静默回退 ad-hoc。

### 修复动作（全程用户域，不需 sudo）
1. `security delete-certificate` 删除损坏的旧证书；
2. openssl 重新生成完整的自签名证书 + 私钥（补 `keyUsage=digitalSignature` + `extendedKeyUsage=codeSigning`）；
3. 打包 legacy p12 → `security import -T /usr/bin/codesign` 导入登录钥匙串；
4. `security add-trusted-cert -r trustRoot -p codeSign`（**用户域信任**）设为受信任；
5. 实测 `codesign --force --deep --sign "SnapCraft Local"` → `Authority=SnapCraft Local`（非 adhoc），验签通过；
6. 用证书重签当前 dev app 并重新打开（新窗口）；
7. `export SNAP_SIGN_ID="SnapCraft Local"` 写入 `~/.zshrc`（以后 `start.sh dev` 自动走证书路径）。

### ⚠️ 需要你做一次性操作
签名身份从 ad-hoc 换成了证书，macOS 把它当**新 app**，需要重新授权屏幕录制一次：

> **系统设置 → 隐私与安全性 → 屏幕录制**（面板已自动打开）
> 找到 **SnapCraft (dev)** 打开开关（如果里面有旧的、灰的同名项，可一并删掉再授权新的）。

授权后即可正常截图。**这是最后一次**——证书身份稳定，以后改代码重编重签，权限都保留。

---

## 问题 B：缩放不对/没截全 = HiDPI 缩放屏 scale 探测 bug（老问题）

### 根因
代码用 `CGDisplayPixelsWide/High` 探测显示器物理像素，但这个 API 在 **HiDPI「缩放」显示器**上返回的是**逻辑点数，不是真实 backing 像素**。

实测你左侧那台 4K 屏（用 1080p 缩放模式）：

| API | 返回值 | 说明 |
|-----|--------|------|
| `CGDisplayPixelsWide` | **1920** | ❌ 错（返回逻辑点） |
| `CGDisplayModeGetPixelWidth` | **3840** | ✅ 真实 backing，与 screencapture 实际输出一致 |
| `CGDisplayModeGetWidth` | 1920 | 逻辑点 |

结果：scale 被误算成 1.0，前端拿"1x 的元数据"去处理一张实际 2x 的图 → **缩放不对、显示不全、编辑坐标错位**。

### 修复
- 新增 `display_backing_pixels()`，改用 `CGDisplayCopyDisplayMode` + `CGDisplayModeGetPixelWidth/Height`（真实 backing 像素）计算 scale；
- 替换 `list_displays` 与 `capture_screen` 中共 3 处 `CGDisplayPixelsWide/High` 调用；
- `cargo build`（DEP_TAURI_DEV=1）通过（6.95s）。

---

## 改动文件
- `src-tauri/src/commands/capture.rs`：新增 `display_backing_pixels()`，修正 scale/物理像素探测（extern 声明改用 `CGDisplayCopyDisplayMode` 系列）。
- `~/.zshrc`：新增 `export SNAP_SIGN_ID="SnapCraft Local"`。
- 钥匙串：重建并信任 `SnapCraft Local` 代码签名证书。

## 验证
- 编译：`cargo build` exit 0。
- 签名：dev app `Authority=SnapCraft Local`，验签通过，非 adhoc。
- 系统 API 实测确认 backing 像素来源正确。

## 你现在要做的
1. 在已打开的「屏幕录制」面板里，给 **SnapCraft (dev)** 授权（一次性）。
2. 回到 app 点全屏截图 —— 黑屏消失、缩放/尺寸正确。
