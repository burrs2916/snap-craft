#!/bin/bash

# 设置 UTF-8 编码
export LANG=zh_CN.UTF-8
export LC_ALL=zh_CN.UTF-8

# SnapCraft 启动脚本

# 设置颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 日志目录
LOG_DIR="$SCRIPT_DIR/logs"
VITE_LOG="$LOG_DIR/vite.log"
TAURI_LOG="$LOG_DIR/tauri.log"
# 截屏诊断日志（Rust 端 logger 会写入此文件，用于精确定位截图错误）
DEV_LOG="$LOG_DIR/dev.log"

# Vite 开发服务器端口
VITE_PORT=1925

# 进程名称标识
VITE_PROCESS="vite"
TAURI_PROCESS="tauri"
APP_PROCESS="SnapCraft"

# 产品信息
APP_NAME="SnapCraft"
APP_BUNDLE="$SCRIPT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
APP_IDENTIFIER="com.snap-craft.app"

# dev 模式 .app 包（独立于 release 的 com.snap-craft.app，避免 TCC 权限冲突）
# start.sh dev 会把 dev 配置编译的二进制包成此 .app 并打开，使其能进入系统「屏幕录制」TCC 列表
DEV_APP_BUNDLE="$SCRIPT_DIR/src-tauri/target/debug/SnapCraft-dev.app"
DEV_APP_ID="com.snap-craft.app.dev"

# 本地自签名代码签名证书名（强烈推荐设置，无需 Apple 开发者账号）。
# 为什么必须用证书：macOS 屏幕录制 TCC 授权按「签名身份」匹配——
#   · ad-hoc 签名（--sign -）身份=二进制哈希，改代码重编即变 → 每次必丢权限；
#   · 自签名证书（--sign <cert>）身份=证书公钥，稳定不变 → 改代码重编后再用同一
#     证书重签，TCC 仍认得是「同一个被授权的 App」，授权跨重编/重启保留，
#     开发循环（改代码→重启→测功能）不再被打断。
# 创建（一次性，约 3 分钟，无需 Apple ID）：
#   钥匙串访问 → 证书助理 → 创建证书 → 名称填「SnapCraft Local」
#   / 身份类型「自签名根证书」/ 证书类型「代码签名」→ 创建后双击设为「始终信任」。
#   也可直接跑：./start.sh cert  （自动用 openssl+security 创建并设为信任）
#   之后 export SNAP_SIGN_ID="SnapCraft Local"（写进 ~/.zshrc 一劳永逸）。
# 不设置则走 ad-hoc：仅「纯重开且没改代码」能保住权限；改了代码重编权限即失效。
SNAP_SIGN_ID="${SNAP_SIGN_ID:-}"

# 日志函数
log_info() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] [INFO]${NC} $1"
}
log_error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR]${NC} $1"
}
log_warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] [WARN]${NC} $1"
}
log_usage() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] [USAGE]${NC} $1"
}

# 检查 Node.js 环境
check_node() {
    if ! command -v node &> /dev/null; then
        log_error "Node.js 未安装或不在 PATH 中"
        exit 1
    fi
    log_info "Node.js 版本: $(node --version)"
}

# 检查 pnpm 环境
check_pnpm() {
    if ! command -v pnpm &> /dev/null; then
        log_error "pnpm 未安装或不在 PATH 中"
        exit 1
    fi
    log_info "pnpm 版本: $(pnpm --version)"
}

# 检查 Rust 环境
check_rust() {
    if ! command -v cargo &> /dev/null; then
        log_error "Rust/Cargo 未安装或不在 PATH 中"
        exit 1
    fi
    log_info "Rust 版本: $(cargo --version)"
}

# 创建必要目录
create_directories() {
    mkdir -p "$LOG_DIR"
}

# 检查依赖
check_dependencies() {
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        log_warn "依赖未安装，正在安装..."
        cd "$SCRIPT_DIR"
        pnpm install
        if [ $? -ne 0 ]; then
            log_error "依赖安装失败"
            exit 1
        fi
        log_info "依赖安装成功"
    fi
}

# 查找并停止 Vite 进程
stop_vite() {
    log_info "正在查找 Vite 进程..."
    VITE_PIDS=$(lsof -ti:${VITE_PORT} 2>/dev/null)
    if [ ! -z "$VITE_PIDS" ]; then
        log_warn "发现 Vite 进程占用端口 ${VITE_PORT}，正在停止..."
        kill -TERM $VITE_PIDS 2>/dev/null
        sleep 2
        REMAINING_PIDS=$(lsof -ti:${VITE_PORT} 2>/dev/null)
        if [ ! -z "$REMAINING_PIDS" ]; then
            log_warn "强制停止 Vite 进程..."
            kill -9 $REMAINING_PIDS 2>/dev/null
        fi
        log_info "Vite 进程已停止"
    else
        log_info "未发现 Vite 进程"
    fi
}

# 查找并停止 Tauri 进程
stop_tauri() {
    log_info "正在查找 Tauri 相关进程..."
    TAURI_PIDS=$(pgrep -f "tauri" 2>/dev/null || true)
    if [ ! -z "$TAURI_PIDS" ]; then
        log_warn "发现 Tauri 进程，正在停止..."
        kill -TERM $TAURI_PIDS 2>/dev/null
        sleep 2
        REMAINING_PIDS=$(pgrep -f "tauri" 2>/dev/null || true)
        if [ ! -z "$REMAINING_PIDS" ]; then
            log_warn "强制停止 Tauri 进程..."
            kill -9 $REMAINING_PIDS 2>/dev/null
        fi
        log_info "Tauri 进程已停止"
    else
        log_info "未发现 Tauri 进程"
    fi
}

# 查找并停止应用进程
stop_app() {
    log_info "正在查找应用进程..."
    APP_PIDS=$(pgrep -f "$APP_PROCESS" 2>/dev/null || true)
    if [ ! -z "$APP_PIDS" ]; then
        log_warn "发现应用进程，正在停止..."
        kill -TERM $APP_PIDS 2>/dev/null
        sleep 2
        REMAINING_PIDS=$(pgrep -f "$APP_PROCESS" 2>/dev/null || true)
        if [ ! -z "$REMAINING_PIDS" ]; then
            log_warn "强制停止应用进程..."
            kill -9 $REMAINING_PIDS 2>/dev/null
        fi
        log_info "应用进程已停止"
    else
        log_info "未发现应用进程"
    fi
}

# 停止所有相关进程
stop_all_processes() {
    log_info "正在停止所有相关进程..."
    stop_vite
    stop_tauri
    stop_app
    log_info "所有相关进程已停止"
}

# 前置检查
pre_check() {
    check_node
    check_pnpm
    check_rust
    create_directories
    check_dependencies
}

# 启动开发模式（.app 包形式，可授权屏幕录制；前端走 vite HMR）
# 做法：用 vite 起前端 dev server（HMR），并以 dev 配置（DEP_TAURI_DEV=1，
#   不启用 custom-protocol 特性）编译 Rust 二进制（走 devUrl 连 vite），再包成
#   .app、签名、打开。相比 pnpm tauri dev 直接跑裸二进制，这样产出的 .app
#   拥有 Info.plist / Bundle ID，可被系统授予「屏幕录制」TCC 权限。
# 注：改了 Rust 代码需重跑本脚本；改前端走 vite HMR，无需重开。
start_dev() {
    log_info "SnapCraft 开发模式（.app 包，可授权屏幕录制）启动脚本"
    echo "========================================"

    # 前置检查
    pre_check

    # 停止所有相关进程（含可能残留的裸二进制 / 旧 dev .app）
    stop_all_processes

    # 截屏诊断日志：注入绝对路径给 Rust 端 logger，并清空上一次运行的旧日志
    # （即便用 open 启动 .app 时丢弃了该环境变量，Rust 端也会用编译期兜底路径
    #  写入 logs/dev.log，见 src-tauri/src/logger.rs）
    mkdir -p "$LOG_DIR"
    export SNAP_LOG_FILE="$DEV_LOG"
    : > "$DEV_LOG"
    log_info "截屏诊断日志: $DEV_LOG  （实时查看：tail -f logs/dev.log）"

    # 1) 前端 dev server（vite，端口与 tauri.conf.json 的 devUrl 一致）
    log_info "正在启动前端 dev server (vite, 端口 $VITE_PORT) ..."
    ( cd "$SCRIPT_DIR" && nohup pnpm dev > "$VITE_LOG" 2>&1 & )
    for i in $(seq 1 30); do
        if lsof -ti:"$VITE_PORT" >/dev/null 2>&1; then
            log_info "前端 dev server 已就绪: http://localhost:$VITE_PORT"
            break
        fi
        sleep 1
    done

    # 2) 以 dev 配置编译 Rust 二进制
    #    （仅在有 Rust 改动时重编，纯为构建速度优化；与「权限是否保留」无关——
    #     权限保留靠下面第 3 步的「自签名证书」，见该步说明）
    #    DEP_TAURI_DEV=1 → tauri-build 不启用 custom-protocol 特性，运行时 is_dev()
    #    为真、走 devUrl 连 vite；touch build.rs 强制 build script 重跑以读取该变量。
    #    用 .dev_build_marker 标记「当前二进制确为 dev 模式」，避免误复用 release 二进制。
    cd "$SCRIPT_DIR/src-tauri"
    BIN="$SCRIPT_DIR/src-tauri/target/debug/snap-craft"
    DEV_MARKER="$SCRIPT_DIR/src-tauri/target/debug/.dev_build_marker"
    NEED_REBUILD=0
    if [ ! -x "$BIN" ] || [ ! -f "$DEV_MARKER" ]; then
        NEED_REBUILD=1
    elif [ "$SCRIPT_DIR/src-tauri/build.rs" -nt "$BIN" ]; then
        NEED_REBUILD=1
    elif [ -n "$(find "$SCRIPT_DIR/src-tauri/src" -name '*.rs' -newer "$BIN" 2>/dev/null | head -1)" ]; then
        NEED_REBUILD=1
    # capabilities/*.json 与 tauri.conf.json 是编译期嵌入二进制的（窗口权限校验在 Rust 运行时），
    # 改了它们必须重编，否则新窗口标签/权限（如 pin-*）不会生效 → start_dragging/close 被拒。
    elif [ -n "$(find "$SCRIPT_DIR/src-tauri/capabilities" -name '*.json' -newer "$BIN" 2>/dev/null | head -1)" ]; then
        NEED_REBUILD=1
    elif [ "$SCRIPT_DIR/src-tauri/tauri.conf.json" -nt "$BIN" ]; then
        NEED_REBUILD=1
    fi
    if [ "$NEED_REBUILD" = "1" ]; then
        log_info "正在以 dev 配置编译 Rust 二进制 (DEP_TAURI_DEV=1, 走 devUrl) ..."
        touch build.rs
        if ! DEP_TAURI_DEV=1 cargo build 2>&1 | tail -6; then
            log_error "Rust 编译失败，请查阅上方输出"
            exit 1
        fi
        touch "$DEV_MARKER"
        log_info "✅ dev 模式二进制已编译"
    else
        log_info "✅ 复用已有 dev 模式二进制（无 Rust 改动，跳过重编以保持签名稳定）"
    fi
    if [ ! -x "$BIN" ]; then
        log_error "未找到编译产物: $BIN"
        exit 1
    fi

    # 3) 包成 .app 并签名
    #    ⚠️ 核心认知：macOS 屏幕录制 TCC 授权按「签名身份」匹配。
    #       - ad-hoc 签名（--sign -）：身份 = 二进制哈希(CDHash)，重编即变
    #         → 每次改代码重编后签名变 → TCC 认不出已授权 App → 必须重授权。
    #       - 自签名证书（--sign <cert>）：身份 = 证书公钥，稳定不变
    #         → 即便改代码重编、重新签名，TCC 仍认得是「同一个被授权的 App」
    #         → 授权可跨重编、跨重启保留，开发循环（改代码→重开→测）不再被打断。
    #    策略：
    #       · 本机存在自签名证书 → 直接重建 .app 并用该证书签名（开发循环自由，权限稳）。
    #       · 无证书 → 仅「无 Rust 改动」时复用已有 .app 及其 ad-hoc 签名以尽量保权限；
    #         一旦改了代码就必然重签、权限失效（此时强烈建议创建自签名证书）。
    APP_BIN="$DEV_APP_BUNDLE/Contents/MacOS/SnapCraft"
    # 若未显式设置 SNAP_SIGN_ID，自动探测常见自签名证书名（避免每次手设环境变量）
    if [ -z "$SNAP_SIGN_ID" ]; then
        for cand in "SnapCraft Local" "SnapCraft Dev"; do
            if cert_exists "$cand"; then
                SNAP_SIGN_ID="$cand"
                log_info "🔍 自动选用签名身份：$SNAP_SIGN_ID（写 export SNAP_SIGN_ID=\"$cand\" 到 ~/.zshrc 可固定）"
                break
            fi
        done
    fi
    if [ -n "$SNAP_SIGN_ID" ] && cert_exists "$SNAP_SIGN_ID"; then
        # 有稳定签名身份：改代码随便重编，权限都留得住
        build_dev_app_bundle "$BIN"
        log_info "✅ 用自签名证书【$SNAP_SIGN_ID】签名 dev .app：改代码重编后 TCC 屏幕录制授权可跨重启保留，开发循环不再被打断。"
    else
        # 无证书：ad-hoc 重签每次都会丢权限。仅在「无 Rust 改动」时复用旧 .app 保签名；
        #         改了代码则必须重建重签（权限失效，属 ad-hoc 的固有限制）。
        NEED_REBUNDLE=0
        if [ ! -d "$DEV_APP_BUNDLE" ] || [ "$NEED_REBUILD" = "1" ] || [ "$BIN" -nt "$APP_BIN" ]; then
            NEED_REBUNDLE=1
        fi
        if [ "$NEED_REBUNDLE" = "1" ]; then
            if [ "$NEED_REBUILD" = "1" ]; then
                log_warn "⚠️ 未配置自签名证书：本次改了 Rust 代码，重建 dev .app 并 ad-hoc 重签 → 屏幕录制授权已失效，需重授权一次。"
                log_warn "   一劳永逸方案：./start.sh cert  （自动创建本机自签名证书），之后改代码也免重授权。"
            fi
            build_dev_app_bundle "$BIN"
        else
            log_info "✅ 复用已有 dev .app（无 Rust 改动，保留其 ad-hoc 签名以维持 TCC 授权）"
        fi
    fi

    # 4) 打开 dev .app（拥有 Info.plist / Bundle ID，可进入 TCC 列表）
    log_info "正在打开 $DEV_APP_BUNDLE ..."
    open "$DEV_APP_BUNDLE"
    cat <<'EOF'

────────────────────────────────────────────
✅ 已以 .app 形式打开（开发模式：前端走 vite HMR，改 UI 即时生效）
👉 若本机已配「自签名证书」并设 SNAP_SIGN_ID：改代码、重跑本脚本权限都留得住，开发循环不再被打断。
👉 若未配证书（ad-hoc）：仅纯重开能保住权限；一旦改了 Rust 代码重编，需重新授权一次（建议配证书）。
👉 首次使用若尚未授权：点一次「全屏截图」会弹系统「屏幕录制」授权，点「允许」。
👉 系统设置 → 隐私与安全性 → 屏幕录制 里能看到 SnapCraft（dev）且开关已开。
👉 截屏问题查 logs/dev.log（已注入全链路诊断日志）。
👉 重置 dev .app 权限：tccutil reset All com.snap-craft.app.dev
────────────────────────────────────────────
EOF
}

# 构建项目（前端）
build_project() {
    log_info "正在构建 SnapCraft 前端..."
    pre_check
    cd "$SCRIPT_DIR"
    log_info "正在构建前端..."
    pnpm build
    if [ $? -ne 0 ]; then
        log_error "前端构建失败"
        exit 1
    fi
    log_info "前端构建成功"
    log_info "输出目录: $SCRIPT_DIR/dist"
}

# 构建 Tauri 应用
build_tauri() {
    log_info "正在构建 SnapCraft Tauri 应用..."
    pre_check
    cd "$SCRIPT_DIR"
    log_info "正在构建 Tauri 应用..."
    pnpm tauri build
    if [ $? -ne 0 ]; then
        log_error "Tauri 应用构建失败"
        exit 1
    fi
    log_info "Tauri 应用构建成功"
    log_info "产物: $APP_BUNDLE"
}

# 本地验收构建：只打 .app，跳过 DMG 与 Apple 公证
# 因为 tauri dev 跑的是裸二进制、不进 TCC 列表，验收必须用 build 出的 .app；
# 而完整 tauri build 会在 DMG 打包/公证阶段失败（Apple API Key 与 keychain-profile 不匹配），
# 本地测权限并不需要 DMG/公证，故显式仅构建 app 目标，并取消公证相关环境变量。
build_app_local() {
    log_info "正在构建 SnapCraft.app（本地验收模式：仅 .app，跳过 DMG/公证）..."
    pre_check
    cd "$SCRIPT_DIR"
    env -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
        -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
        -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
        pnpm tauri build --bundles app
    if [ $? -ne 0 ]; then
        log_error "本地 .app 构建失败"
        exit 1
    fi
    log_info "本地 .app 构建成功"
    # 若本机存在自签名证书，重签 .app 以被 Gatekeeper 信任（无需 Apple 开发者账号）
    codesign_app_local
    log_info "产物: $APP_BUNDLE"
}

# 构建并打开 SnapCraft.app（开发期验收截图/屏幕录制权限）
open_snapcraft_app() {
    if [ ! -d "$APP_BUNDLE" ]; then
        log_warn "未找到已构建的 $APP_NAME.app，先执行构建..."
        build_app_local
    fi
    if [ ! -d "$APP_BUNDLE" ]; then
        log_error "构建后仍未找到 $APP_BUNDLE"
        exit 1
    fi
    log_info "正在打开 $APP_NAME.app ..."
    open "$APP_BUNDLE"
    cat <<'EOF'

────────────────────────────────────────────
✅ 已打开 SnapCraft.app
👉 首次使用请点一次「全屏截图」，会弹出系统「屏幕录制」授权请求，点「允许」。
👉 之后去 系统设置 → 隐私与安全性 → 屏幕录制，就能看到 SnapCraft（dev）且开关已开。
👉 若之前卡住：bash start.sh reset  再重新截图授权。
────────────────────────────────────────────
EOF
}

# 重置 SnapCraft 的 TCC 权限（macOS 12+ 支持）
reset_permissions() {
    log_info "重置 $APP_NAME 的 TCC 权限 ($APP_IDENTIFIER) ..."
    tccutil reset All "$APP_IDENTIFIER" 2>/dev/null || log_warn "（tccutil 不可用或已跳过；macOS 12+ 才支持）"
    log_info "已重置。下次打开 .app 截图会重新请求授权。"
}

# 将 dev 二进制包成 .app（拥有 Info.plist / Bundle ID，可进入 TCC 列表）
# 并签名：有本地自签名证书则用其（Gatekeeper 信任、TCC 稳定），否则 ad-hoc。
# 本地构建的文件不带 quarantine，直接 open 即可，无需「右键→打开」。
build_dev_app_bundle() {
    local bin="$1"
    local app="$DEV_APP_BUNDLE"
    local id="$DEV_APP_ID"
    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp "$bin" "$app/Contents/MacOS/SnapCraft"
    chmod +x "$app/Contents/MacOS/SnapCraft"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>SnapCraft (dev)</string>
    <key>CFBundleDisplayName</key><string>SnapCraft (dev)</string>
    <key>CFBundleIdentifier</key><string>$id</string>
    <key>CFBundleExecutable</key><string>SnapCraft</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>10.13</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
    # 1) 优先用本机自签名证书（Gatekeeper 信任、TCC 授权跨重编稳定）
    #    --options=runtime 启用 Hardened Runtime（App Store 必需；dev 也开方便提前验证）
    if [ -n "$SNAP_SIGN_ID" ] && cert_exists "$SNAP_SIGN_ID"; then
        log_info "用本机自签名证书「$SNAP_SIGN_ID」对 dev .app 签名（--options=runtime）..."
        if codesign --force --deep --options runtime --sign "$SNAP_SIGN_ID" "$app" 2>&1; then
            log_info "✅ 证书签名完成（Hardened Runtime 已启用）"
        else
            log_warn "⚠️ 证书签名失败（可能被钥匙串锁定），回退 ad-hoc"
        fi
    fi
    # 2) 确保有签名（TCC 要求应用已签名）：未签名或证书失败时做 ad-hoc
    #    ad-hoc 也开 --options=runtime，让 dev 与 prod 行为一致（方便提前暴露 runtime 问题）
    if ! codesign -v "$app" >/dev/null 2>&1; then
        log_info "对 dev .app 进行 ad-hoc 签名（Hardened Runtime + TCC 要求）..."
        codesign --force --deep --options runtime --sign - "$app" 2>&1 || log_warn "⚠️ ad-hoc 签名失败"
    fi
    # 本地构建不带隔离属性，去除以防万一
    xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
    log_info "✅ dev .app 已就绪: $app"
}

# 备份当前 dev 签名身份（公钥身份持久化所需）
# 为什么需要备份：
#   dev 自签名证书（默认「SnapCraft Local」）保证 TCC 屏幕录制授权跨重编保留。
#   升级系统 / 还原 Time Machine / 重装 macOS 后，钥匙串会丢，必须从备份恢复。
#   不备份就只能重新创建 + 重新授权（开发循环友好性倒退）。
# 备份内容：
#   1) 证书本身（login 钥匙串）：用 security export -k login -o <file>.p12 导出 p12
#   2) 证书备份目录：~/.snapcraft/keys/（首次备份时创建）
#   3) 钥匙串信任状态：需要重新「始终信任」（导出后无法保留信任设置）
# 恢复：
#   security import <file>.p12 -k login -P <password> -T /usr/bin/codesign
#   钥匙串访问 → 登录 → 证书 → 双击 → 信任 → 代码签名：始终信任
#   export SNAP_SIGN_ID="SnapCraft Local"
# 用法：./start.sh backup-cert           # 备份当前 dev 证书到 ~/.snapcraft/keys/
#       ./start.sh restore-cert <file>   # 从 .p12 恢复
backup_cert() {
    local name="${SNAP_SIGN_ID:-SnapCraft Local}"
    local backup_dir="$HOME/.snapcraft/keys"
    mkdir -p "$backup_dir"
    local out="$backup_dir/${name}-$(date +%Y%m%d-%H%M%S).p12"
    log_info "备份证书「$name」到 $out"
    if ! cert_exists "$name"; then
        log_error "未在登录钥匙串中找到证书「$name」。"
        log_warn "提示：若从未创建过，先跑 ./start.sh cert 创建。"
        return 1
    fi
    # 导出 p12（需输入钥匙串访问密码，弹 GUI 授权框）
    if ! security export -k login -t identities -f pkcs12 -o "$out" -P "" -A "" 2>/dev/null; then
        # 上述命令要求非空密码；用 -P prompt 走到 GUI 弹窗
        if ! security export -k login -t identities -f pkcs12 -o "$out" 2>/dev/null; then
            log_error "导出失败。请在钥匙串访问中手动导出："
            log_warn "  1) 钥匙串访问 → 登录 → 我的证书"
            log_warn "  2) 选中「$name」→ 菜单 文件 → 导出项目 → 格式:个人信息交换(.p12)"
            log_warn "  3) 保存到 $backup_dir/${name}.p12（密码留空或自定）"
            return 1
        fi
    fi
    # 记录元数据（人类可读）
    local meta="$backup_dir/${name}.meta"
    cat > "$meta" <<META
# SnapCraft dev 签名证书备份元数据
# 名称: $name
# 备份时间: $(date '+%Y-%m-%d %H:%M:%S')
# 备份机器: $(hostname)
# 系统版本: $(sw_vers -productVersion 2>/dev/null || echo unknown)
# 钥匙串: login

# === 恢复步骤 ===
# 1) 把本目录拷贝到新机器（或 Time Machine 还原）
# 2) 钥匙串访问 → 登录 → 我的证书 → 菜单 文件 → 导入项目 → 选 $(basename "$out")
# 3) 双击「$name」→ 信任 → 代码签名：始终信任
# 4) export SNAP_SIGN_ID="$name"  （写进 ~/.zshrc）
# 5) ./start.sh dev 验证（无需重新授权 TCC，因公钥身份一致）
META
    log_info "✅ 证书已备份到: $out"
    log_info "   元数据:        $meta"
    log_info "   备份目录:      $backup_dir"
    log_warn "⚠️ 信任设置未随 p12 导出，恢复后需手动在钥匙串中设为「始终信任」"
    log_warn "⚠️ 备份文件含私钥，请妥善保管（建议存加密磁盘 / 1Password）"
}

# 从 p12 备份恢复 dev 签名证书
# 用法：./start.sh restore-cert <file.p12> [name]
restore_cert() {
    local file="$1"
    local name="${2:-SnapCraft Local}"
    if [ -z "$file" ] || [ ! -f "$file" ]; then
        log_error "用法: ./start.sh restore-cert <file.p12> [cert-name]"
        return 1
    fi
    log_info "从 $file 恢复证书「$name」..."
    if cert_exists "$name"; then
        log_warn "钥匙串中已存在「$name」，将先删除旧证书避免冲突"
        security delete-identity -c "$name" login 2>/dev/null || true
    fi
    if ! security import "$file" -k login -T /usr/bin/codesign 2>/dev/null; then
        log_error "导入失败。请改用钥匙串访问 GUI 手动导入："
        log_warn "  1) 钥匙串访问 → 登录 → 我的证书"
        log_warn "  2) 菜单 文件 → 导入项目 → 选 $file"
        log_warn "  3) 导入后双击「$name」→ 信任 → 代码签名：始终信任"
        return 1
    fi
    log_info "✅ 证书「$name」已导入登录钥匙串"
    if ! cert_exists "$name"; then
        log_warn "⚠️ 证书已导入，但 codesign 需「受信任」身份才能用"
        log_warn "   请到钥匙串访问 → 双击「$name」→ 信任 → 代码签名：始终信任"
    fi
    log_info "👉 写 export SNAP_SIGN_ID=\"$name\" 到 ~/.zshrc 即可长期使用"
}

# 检查本机钥匙串是否存在指定名称的代码签名证书
cert_exists() {
    local name="$1"
    [ -z "$name" ] && return 1
    command -v security >/dev/null 2>&1 || return 1
    security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$name\""
}

# 一键创建本机自签名代码签名证书（无需 Apple 开发者账号）
# 让 dev .app 的 TCC 屏幕录制授权跨重编/重启保留（见 start_dev 第 3 步说明）。
# 优先走 openssl+security CLI；失败则打印钥匙串 GUI 手动步骤兜底。
create_dev_cert() {
    local name="SnapCraft Local"
    log_info "创建本机自签名代码签名证书：$name"
    if cert_exists "$name"; then
        log_warn "证书「$name」已存在，无需重复创建。"
        export SNAP_SIGN_ID="$name"
        log_info "已设 SNAP_SIGN_ID=$name"
        return 0
    fi
    if ! command -v openssl >/dev/null 2>&1; then
        log_error "未找到 openssl，无法自动创建。请改用钥匙串 GUI："
        print_cert_gui_steps
        return 1
    fi
    local tmp
    tmp="$(mktemp -d)"
    local key="$tmp/key.pem" cert="$tmp/cert.pem" p12="$tmp/identity.p12"
    if ! openssl req -x509 -newkey rsa:2048 -keyout "$key" -out "$cert" -days 3650 \
        -subj "/CN=$name" -addext "extendedKeyUsage=codeSigning" -nodes 2>/dev/null; then
        log_error "openssl 生成证书失败，请改用钥匙串 GUI（见下方）。"
        print_cert_gui_steps
        rm -rf "$tmp"
        return 1
    fi
    # ⚠️ macOS security 命令不兼容 OpenSSL 3.x 默认加密算法（MAC 验证失败），
    #    必须用 -legacy 生成旧格式 p12 + 非空密码（空密码也会 MAC 失败）
    if ! openssl pkcs12 -export -legacy -out "$p12" -inkey "$key" -in "$cert" -passout pass:snapcraft 2>/dev/null; then
        log_error "打包 p12 失败，请改用钥匙串 GUI（见下方）。"
        print_cert_gui_steps
        rm -rf "$tmp"
        return 1
    fi
    # 用完整钥匙串路径（-k login 在某些环境找不到钥匙串）
    local kc="$HOME/Library/Keychains/login.keychain-db"
    if ! security import "$p12" -k "$kc" -P snapcraft -T /usr/bin/codesign 2>/dev/null; then
        log_error "导入钥匙串失败（可能需解锁登录钥匙串或弹了授权框被取消）。请改用钥匙串 GUI："
        print_cert_gui_steps
        rm -rf "$tmp"
        return 1
    fi
    rm -rf "$tmp"
    log_info "✅ 证书「$name」已导入登录钥匙串。"
    # codesign 只能用「受信任」(valid) 的身份签名。
    # 设信任需要管理员权限（弹 GUI 授权框），无法在脚本中静默完成——需用户手动操作。
    if ! cert_exists "$name"; then
        log_warn ""
        log_warn "⚠️ 证书已导入，但还需一步：设为「始终信任」(codesign 只用受信任的身份)"
        log_warn "   1) ⌘+Space 搜索「钥匙串访问」，打开它"
        log_warn "   2) 左侧选「登录」钥匙串 → 上方选「证书」"
        log_warn "   3) 双击「SnapCraft Local」→ 展开「信任」"
        log_warn "   4) 「使用此证书时」选「始终信任」→ 关闭 → 输入密码"
        log_warn "   5) 回到终端：export SNAP_SIGN_ID=\"$name\" && ./start.sh dev"
        return 1
    fi
    export SNAP_SIGN_ID="$name"
    log_info "✅ 证书「$name」已就绪（受信任）。已将 SNAP_SIGN_ID 指向它。"
    log_info "👉 建议写进 ~/.zshrc：export SNAP_SIGN_ID=\"$name\""
    log_info "👉 之后直接 ./start.sh dev，改代码重编后屏幕录制权限也保留。"
}

# 钥匙串 GUI 手动创建证书的步骤（CLI 自动创建失败时的兜底）
print_cert_gui_steps() {
    cat <<'EOF'

──────── 钥匙串 GUI 手动创建（一次性，约 3 分钟，无需 Apple ID）────────
1) 打开「钥匙串访问」(Keychain Access)
2) 菜单 钥匙串访问 → 证书助理 → 创建证书...
3) 名称填：SnapCraft Local
4) 身份类型：自签名根证书
5) 证书类型：代码签名
6) 有效期按需（建议 3650 天）
7) 创建完成后，在「我的证书」找到它，双击 → 信任 → 代码签名：始终信任
8) 终端执行：export SNAP_SIGN_ID="SnapCraft Local"（写进 ~/.zshrc 一劳永逸）
─────────────────────────────────────────────────────────────────────
EOF
}

# 用本地自签名证书对构建出的 .app 重签，使其被 Gatekeeper 信任（无需 Apple 开发者账号）
# 启用 Hardened Runtime（App Store 必需，dev 也开）
codesign_app_local() {
    [ -d "$APP_BUNDLE" ] || return 0
    if [ -n "$SNAP_SIGN_ID" ] && cert_exists "$SNAP_SIGN_ID"; then
        log_info "用本机自签名证书「$SNAP_SIGN_ID」对 .app 重新签名（Hardened Runtime + Gatekeeper）..."
        if codesign --force --deep --options runtime --sign "$SNAP_SIGN_ID" "$APP_BUNDLE" 2>&1; then
            log_info "✅ 重签名完成，可直接打开，无需「右键→打开」。"
        else
            log_warn "⚠️ 重签名失败：证书可能已被钥匙串锁定，请先解锁「登录」钥匙串后重试。"
        fi
        # 兜底去除隔离属性（若 .app 曾从 CI 下载）
        xattr -dr com.apple.quarantine "$APP_BUNDLE" 2>/dev/null || true
    else
        log_warn "未设置 SNAP_SIGN_ID 或未找到本机证书，走默认 ad-hoc 签名（仍开 --options=runtime）。"
        codesign --force --deep --options runtime --sign - "$APP_BUNDLE" 2>&1 || log_warn "⚠️ ad-hoc 签名失败"
        log_warn "首次打开需：右键 SnapCraft.app → 打开（一次性放行）；或 sudo xattr -dr com.apple.quarantine \"$APP_BUNDLE\""
    fi
}

# 验证 .app 是否已开启 Hardened Runtime + 签名
# 用法：./start.sh verify-sign [app-path]
# 默认验证 dev .app（$DEV_APP_BUNDLE）
verify_sign() {
    local app="${1:-$DEV_APP_BUNDLE}"
    if [ ! -d "$app" ]; then
        log_error "未找到 $app，请先用 ./start.sh dev 或 ./start.sh app 构建"
        return 1
    fi
    log_info "验证 $app 的签名与 Hardened Runtime..."
    echo "─── codesign -dv ───"
    codesign -dv --verbose=4 "$app" 2>&1 | head -30
    echo ""
    echo "─── Hardened Runtime 状态 ───"
    local opts
    opts=$(codesign -dv "$app" 2>&1 | grep -E "^flags=|Flags=" || echo "(未检测到 flags)")
    echo "$opts"
    if echo "$opts" | grep -qE "(runtime|hard);"; then
        log_info "✅ Hardened Runtime 已启用（flags 含 runtime）"
    else
        log_warn "❌ Hardened Runtime 未启用！需用 codesign --options runtime 重签。"
        return 1
    fi
    echo ""
    echo "─── 签名身份 ───"
    codesign -dv "$app" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier|Format)" || true
    echo ""
    echo "─── 完整性验证 ───"
    codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | head -10
    if codesign --verify --deep --strict "$app" 2>/dev/null; then
        log_info "✅ 签名完整性验证通过"
    else
        log_error "❌ 签名完整性验证失败"
        return 1
    fi
}

# 仅对已有 .app 重新签名（用于重签 CI 下载的包 / 切换证书）
sign_app_local() {
    if [ ! -d "$APP_BUNDLE" ]; then
        log_error "未找到 $APP_BUNDLE，请先用 './start.sh app' 构建。"
        exit 1
    fi
    if [ -z "$SNAP_SIGN_ID" ]; then
        log_error "请先设置 SNAP_SIGN_ID（你的证书名，如 SnapCraft Local）后再执行。"
        exit 1
    fi
    codesign_app_local
}

# 停止服务
stop_services() {
    log_info "SnapCraft 停止脚本"
    echo "========================================"
    stop_all_processes
}

# 显示帮助信息
show_help() {
    echo "SnapCraft 管理脚本"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  dev              启动开发模式（.app 包形式，可授权屏幕录制；前端走 vite HMR）"
    echo "  stop             停止所有相关进程"
    echo "  build            构建前端"
    echo "  build-tauri      构建 Tauri 应用（不打开）"
    echo "  app              构建并打开 SnapCraft.app（开发期验收屏幕录制权限，自动用本地证书签名）"
    echo "  sign             用本地自签名证书重签已构建的 .app（无需 Apple 开发者账号）"
    echo "  cert             一键创建本机自签名代码签名证书（无需 Apple 账号；让截图权限跨重编保留）"
    echo "  backup-cert      备份当前 dev 签名证书到 ~/.snapcraft/keys/（公钥身份持久化）"
    echo "  restore-cert     从 .p12 备份恢复 dev 签名证书（系统升级/换机后用）"
    echo "  verify-sign      验证 .app 签名与 Hardened Runtime 状态（[app-path] 可选）"
    echo "  reset            重置 SnapCraft 的屏幕录制权限"
    echo "  help, -h, --help 显示此帮助信息"
    echo ""
    echo "环境变量:"
    echo "  SNAP_SIGN_ID     本地自签名证书名（如 SnapCraft Local）；设置后 app/sign 自动用其签名，"
    echo "                   使 .app 被 Gatekeeper 信任，开发期可直接打开验收屏幕录制权限。"
    echo ""
    echo "示例:"
    echo "  $0               # 启动开发模式（前后端同时启动）"
    echo "  $0 dev           # 启动开发模式（前后端同时启动）"
    echo "  $0 stop          # 停止所有相关进程"
    echo "  $0 build         # 构建前端"
    echo "  $0 build-tauri   # 仅构建 Tauri 应用"
    echo "  $0 app           # 构建并打开 .app（截图/权限验收用）"
    echo "  $0 cert          # 一键创建自签名证书（首次配置，让改代码也不丢截图权限）"
    echo "  $0 backup-cert   # 备份 dev 签名证书到 ~/.snapcraft/keys/"
    echo "  $0 restore-cert  # 从备份恢复 dev 签名证书"
    echo "  $0 reset         # 重置屏幕录制权限"
    echo "  $0 help          # 查看帮助信息"
}

# 主函数
main() {
    case "$1" in
        dev|"")
            start_dev
            ;;
        stop)
            stop_services
            ;;
        build)
            log_info "SnapCraft 构建脚本"
            echo "========================================"
            build_project
            ;;
        build-tauri)
            log_info "SnapCraft Tauri 应用构建脚本"
            echo "========================================"
            build_tauri
            ;;
        app)
            log_info "SnapCraft 构建并打开（用于开发期验收屏幕录制权限）"
            echo "========================================"
            open_snapcraft_app
            ;;
        reset)
            reset_permissions
            ;;
        sign)
            log_info "SnapCraft 重新签名（本地自签名证书）"
            echo "========================================"
            sign_app_local
            ;;
        cert)
            create_dev_cert
            ;;
        backup-cert)
            backup_cert
            ;;
        restore-cert)
            restore_cert "$2" "$3"
            ;;
        verify-sign)
            verify_sign "$2"
            ;;
        help|-h|--help)
            show_help
            ;;
        *)
            log_error "未知选项: $1"
            log_usage "使用 '$0 help' 查看帮助信息"
            exit 1
            ;;
    esac
}

# 执行主函数
main "$@"
