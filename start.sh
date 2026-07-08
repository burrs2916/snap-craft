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

# Vite 开发服务器端口
VITE_PORT=1422

# 进程名称标识
VITE_PROCESS="vite"
TAURI_PROCESS="tauri"
APP_PROCESS="SnapCraft"

# 产品信息
APP_NAME="SnapCraft"
APP_BUNDLE="$SCRIPT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
APP_IDENTIFIER="com.snap-craft.app"

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

# 启动开发模式（前后端同时启动）
start_dev() {
    log_info "SnapCraft 开发模式启动脚本"
    echo "========================================"

    # 前置检查
    pre_check

    # 停止所有相关进程
    stop_all_processes

    log_info "正在启动开发模式（前后端同时启动）..."
    log_info "前端地址: http://localhost:${VITE_PORT}"
    log_info "Vite 日志: $VITE_LOG"
    log_info "Tauri 日志: $TAURI_LOG"
    log_info "按 Ctrl+C 停止服务"
    echo "----------------------------------------"

    cd "$SCRIPT_DIR"

    # 使用 pnpm tauri dev 启动（会同时启动前后端）
    # 注意：dev 模式跑的是裸二进制，不会进入系统「屏幕录制」权限列表，
    # 仅适合调 UI；截图/权限验收请用 ./start.sh app
    log_info "正在启动 Tauri 开发模式..."
    pnpm tauri dev
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
👉 之后去 系统设置 → 隐私与安全性 → 屏幕录制，就能看到 SnapCraft 且开关已开。
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
    echo "  dev              启动开发模式（前后端同时启动，默认）"
    echo "  stop             停止所有相关进程"
    echo "  build            构建前端"
    echo "  build-tauri      构建 Tauri 应用（不打开）"
    echo "  app              构建并打开 SnapCraft.app（开发期验收屏幕录制权限）"
    echo "  reset            重置 SnapCraft 的屏幕录制权限"
    echo "  help, -h, --help 显示此帮助信息"
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
