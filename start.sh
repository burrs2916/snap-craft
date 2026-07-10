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

# 本地自签名证书名（可选）。创建方式见 README：
#   钥匙串访问 → 证书助理 → 创建证书 → 名称任意（如 SnapCraft Local）
#   / 身份类型「自签名根证书」/ 证书类型「代码签名」→ 创建后选「始终信任」。
# 设置后 ./start.sh app / sign 会自动用该证书对 .app 重签，使其被 Gatekeeper 信任，
# 开发期验收屏幕录制权限时可直接打开。不设置则走 ad-hoc + 手动放行。
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
    #    DEP_TAURI_DEV=1 → tauri-build 不启用 custom-protocol 特性，
    #    运行时 is_dev() 为真、走 devUrl 连 vite；touch build.rs 强制 build
    #    script 重跑以读取该变量（否则可能命中上次 release 缓存）。
    #    不开 custom-protocol 即等于 pnpm tauri dev 的编译产物。
    log_info "正在以 dev 配置编译 Rust 二进制 (DEP_TAURI_DEV=1, 走 devUrl) ..."
    cd "$SCRIPT_DIR/src-tauri"
    touch build.rs
    if ! DEP_TAURI_DEV=1 cargo build 2>&1 | tail -6; then
        log_error "Rust 编译失败，请查阅上方输出"
        exit 1
    fi
    BIN="$SCRIPT_DIR/src-tauri/target/debug/snap-craft"
    if [ ! -x "$BIN" ]; then
        log_error "未找到编译产物: $BIN"
        exit 1
    fi
    log_info "✅ dev 模式二进制已编译"

    # 3) 包成 .app 并签名
    build_dev_app_bundle "$BIN"

    # 4) 打开 dev .app（拥有 Info.plist / Bundle ID，可进入 TCC 列表）
    log_info "正在打开 $DEV_APP_BUNDLE ..."
    open "$DEV_APP_BUNDLE"
    cat <<'EOF'

────────────────────────────────────────────
✅ 已以 .app 形式打开（开发模式：前端走 vite HMR，改 UI 即时生效）
👉 首次使用请点一次「全屏截图」，会弹出系统「屏幕录制」授权，点「允许」。
👉 之后去 系统设置 → 隐私与安全性 → 屏幕录制，即可看到 SnapCraft（dev）且开关已开。
👉 改了 Rust 代码需重跑 ./start.sh dev；改前端走 vite HMR，无需重开。
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
    if [ -n "$SNAP_SIGN_ID" ] && cert_exists "$SNAP_SIGN_ID"; then
        log_info "用本机自签名证书「$SNAP_SIGN_ID」对 dev .app 签名 ..."
        if codesign --force --deep --sign "$SNAP_SIGN_ID" "$app" 2>&1; then
            log_info "✅ 证书签名完成"
        else
            log_warn "⚠️ 证书签名失败（可能被钥匙串锁定），回退 ad-hoc"
        fi
    fi
    # 2) 确保有签名（TCC 要求应用已签名）：未签名或证书失败时做 ad-hoc
    if ! codesign -v "$app" >/dev/null 2>&1; then
        log_info "对 dev .app 进行 ad-hoc 签名（TCC 要求已签名）..."
        codesign --force --deep --sign - "$app" 2>&1 || log_warn "⚠️ ad-hoc 签名失败"
    fi
    # 本地构建不带隔离属性，去除以防万一
    xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
    log_info "✅ dev .app 已就绪: $app"
}

# 检查本机钥匙串是否存在指定名称的代码签名证书
cert_exists() {
    local name="$1"
    [ -z "$name" ] && return 1
    command -v security >/dev/null 2>&1 || return 1
    security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$name\""
}

# 用本地自签名证书对构建出的 .app 重签，使其被 Gatekeeper 信任（无需 Apple 开发者账号）
codesign_app_local() {
    [ -d "$APP_BUNDLE" ] || return 0
    if [ -n "$SNAP_SIGN_ID" ] && cert_exists "$SNAP_SIGN_ID"; then
        log_info "用本机自签名证书「$SNAP_SIGN_ID」对 .app 重新签名（Gatekeeper 信任）..."
        if codesign --force --deep --sign "$SNAP_SIGN_ID" "$APP_BUNDLE" 2>&1; then
            log_info "✅ 重签名完成，可直接打开，无需「右键→打开」。"
        else
            log_warn "⚠️ 重签名失败：证书可能已被钥匙串锁定，请先解锁「登录」钥匙串后重试。"
        fi
        # 兜底去除隔离属性（若 .app 曾从 CI 下载）
        xattr -dr com.apple.quarantine "$APP_BUNDLE" 2>/dev/null || true
    else
        log_warn "未设置 SNAP_SIGN_ID 或未找到本机证书，走默认 ad-hoc 签名。"
        log_warn "首次打开需：右键 SnapCraft.app → 打开（一次性放行）；或 sudo xattr -dr com.apple.quarantine \"$APP_BUNDLE\""
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
