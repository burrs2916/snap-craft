#!/usr/bin/env bash
# =============================================================================
# SnapCraft macOS 公证 (Notarization) 脚本
# =============================================================================
#
# 用途:
#   把已签名的 .app / .dmg / .pkg 提交到 Apple Notary Service
#   (notarytool) 并装订 (stapler) 回分发介质,使其在用户机器上无 Gatekeeper
#   弹窗通过验证。
#
# 前置条件:
#   1. macOS 10.15+ 且已安装 Xcode Command Line Tools (含 notarytool / stapler)
#      xcode-select --install
#   2. Apple Developer ID 账号已注册(见 docs/APPLE_DEVELOPER.md)
#   3. App Store Connect API Key 已生成,保存到 ~/private_keys/AuthKey_XXX.p8
#   4. Apple Distribution 证书已导入钥匙串
#   5. 待公证的 .app 已用 --options runtime 签名
#
# 认证方式(按优先级):
#   1. Keychain Profile(推荐,一次性配置后无需重复输入)
#   2. 直接传 API Key(适合 CI,无需预先 store-credentials)
#   3. Apple ID + App-Specific Password(旧方式,已不推荐)
#
# 用法:
#   # 推荐: Keychain Profile 模式(本地开发)
#   ./scripts/notarize-macos.sh \
#     --keychain-profile snapcraft-notary \
#     --target src-tauri/target/universal-apple-darwin/release/bundle/macos/SnapCraft.app
#
#   # CI 模式: 直接传 API Key
#   ./scripts/notarize-macos.sh \
#     --key ~/private_keys/AuthKey_2X9R4HXF34.p8 \
#     --key-id 2X9R4HXF34 \
#     --issuer 57246542-96fe-1a63-e053-0824d011072a \
#     --target src-tauri/target/universal-apple-darwin/release/bundle/macos/SnapCraft.app
#
#   # DMG 模式(公证后装订到 .dmg)
#   ./scripts/notarize-macos.sh \
#     --keychain-profile snapcraft-notary \
#     --target SnapCraft-0.1.0.dmg \
#     --dmg
#
#   # 仅装订(用于"已公证过的 .app 加 ticket 后转 .dmg"场景)
#   ./scripts/notarize-macos.sh --staple-only --target SnapCraft.app
#
# 退出码:
#   0  成功(Accepted + Stapled + Verified)
#   1  参数错误
#   2  公证被拒(developer_log.json 已写到工作目录)
#   3  装订失败
#   4  验证失败
# =============================================================================

set -euo pipefail

# ---- 颜色输出 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] [INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] [WARN]${NC} $1"; }
log_error() { echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] [STEP]${NC} $1"; }

# ---- 默认值 ----
TARGET=""
KEYCHAIN_PROFILE=""
API_KEY=""
API_KEY_ID=""
API_ISSUER=""
IS_DMG=0
STAPLE_ONLY=0
WAIT_TIMEOUT=30   # 公证最大等待分钟数
NO_STAPLE=0       # 跳过 stapler(用于"分布式分发 + 用户首次运行时 lazy fetch ticket"场景)
DRY_RUN=0         # dry-run 模式:仅打印命令,不真提交

# ---- 参数解析 ----
usage() {
    sed -n '4,/^# ====/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^$/d'
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target|-t)             TARGET="$2"; shift 2;;
        --keychain-profile|-p)   KEYCHAIN_PROFILE="$2"; shift 2;;
        --key|-k)                API_KEY="$2"; shift 2;;
        --key-id)                API_KEY_ID="$2"; shift 2;;
        --issuer|-i)             API_ISSUER="$2"; shift 2;;
        --dmg)                   IS_DMG=1; shift;;
        --staple-only)           STAPLE_ONLY=1; shift;;
        --no-staple)             NO_STAPLE=1; shift;;
        --wait-timeout)          WAIT_TIMEOUT="$2"; shift 2;;
        --dry-run)               DRY_RUN=1; shift;;
        -h|--help)               usage;;
        *)                       log_error "未知参数: $1"; usage;;
    esac
done

# ---- 校验前置条件 ----
if [[ -z "$TARGET" ]]; then
    log_error "未指定 --target"
    usage
fi

if [[ ! -e "$TARGET" ]]; then
    log_error "目标不存在: $TARGET"
    exit 1
fi

# 平台校验:必须 macOS
if [[ "$(uname)" != "Darwin" ]]; then
    log_error "此脚本仅在 macOS 上运行(当前: $(uname))"
    exit 1
fi

# 工具存在性校验
for tool in xcrun codesign xcrun; do
    if ! command -v xcrun >/dev/null 2>&1; then
        log_error "未找到 xcrun,需安装 Xcode Command Line Tools (xcode-select --install)"
        exit 1
    fi
done

# 至少有一种认证方式
if [[ -z "$KEYCHAIN_PROFILE" && (-z "$API_KEY" || -z "$API_KEY_ID" || -z "$API_ISSUER") ]]; then
    log_error "必须提供 --keychain-profile 或全部 --key/--key-id/--issuer"
    usage
fi

# ---- 准备认证参数 ----
AUTH_ARGS=()
if [[ -n "$KEYCHAIN_PROFILE" ]]; then
    AUTH_ARGS+=("--keychain-profile" "$KEYCHAIN_PROFILE")
    log_info "认证: Keychain Profile \"$KEYCHAIN_PROFILE\""
else
    AUTH_ARGS+=("--key" "$API_KEY" "--key-id" "$API_KEY_ID" "--issuer" "$API_ISSUER")
    log_info "认证: API Key $API_KEY_ID (Issuer ${API_ISSUER:0:8}...)"
fi

# ---- 仅装订模式 ----
if [[ "$STAPLE_ONLY" == "1" ]]; then
    log_step "仅装订模式: $TARGET"
    if [[ "$DRY_RUN" == "1" ]]; then
        log_info "[DRY-RUN] xcrun stapler staple \"$TARGET\""
    else
        xcrun stapler staple "$TARGET"
        log_info "✅ Stapled"
        xcrun stapler validate "$TARGET"
    fi
    exit 0
fi

# ---- Step 1: 提交公证 ----
log_step "Step 1/3: 提交公证到 Apple Notary Service"
log_info "  目标: $TARGET"
log_info "  类型: $([ "$IS_DMG" == "1" ] && echo "DMG" || echo "APP")"
log_info "  等待超时: ${WAIT_TIMEOUT} 分钟"

if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] xcrun notarytool submit \"$TARGET\" ${AUTH_ARGS[*]} --wait --timeout ${WAIT_TIMEOUT}m"
    log_info "[DRY-RUN] 跳过实际提交(DRY-RUN)"
    exit 0
fi

# 提交并等待结果
SUBMIT_LOG="$(mktemp -t notary-submit.XXXXXX.log)"
log_info "  详细日志: $SUBMIT_LOG"
if ! xcrun notarytool submit "$TARGET" "${AUTH_ARGS[@]}" --wait --timeout "${WAIT_TIMEOUT}m" 2>&1 | tee "$SUBMIT_LOG"; then
    log_error "❌ 公证提交失败"
    log_error "  日志: $SUBMIT_LOG"
    log_warn "  提示: 高峰期(美国时间下午)公证可能 30+ 分钟,超时请增大 --wait-timeout"
    exit 2
fi

# 检查提交结果(从输出最后一行解析)
RESULT=$(grep -E "Successfully uploaded|Accepted|Invalid|Rejected" "$SUBMIT_LOG" | tail -1 || echo "")
if echo "$RESULT" | grep -q "Accepted"; then
    log_info "✅ 公证通过 (Accepted)"
elif echo "$RESULT" | grep -q "Invalid\|Rejected"; then
    log_error "❌ 公证被拒 ($RESULT)"
    log_error "  详细错误请到 https://developer.apple.com/account 或下载 notary 日志查看"
    # 拉取 developer_log.json
    SUBMISSION_ID=$(echo "$RESULT" | grep -oE 'id: [a-f0-9-]+' | head -1 | awk '{print $2}' || true)
    if [[ -n "${SUBMISSION_ID:-}" ]]; then
        log_warn "  拉取详细错误: xcrun notarytool log $SUBMISSION_ID ${AUTH_ARGS[*]}"
    fi
    exit 2
else
    log_warn "无法从日志中识别结果(可能为长输出),请人工检查: $SUBMIT_LOG"
fi

# ---- Step 2: 装订 ----
if [[ "$NO_STAPLE" == "1" ]]; then
    log_info "⏭️ 跳过 stapler(--no-staple),ticket 留待用户首次启动时 lazy fetch"
    exit 0
fi

log_step "Step 2/3: 装订 (stapler)"
if ! xcrun stapler staple "$TARGET" 2>&1; then
    log_error "❌ 装订失败"
    log_warn "  常见原因: 1) 公证服务未返回 ticket 2) .app 未正确签名(--options runtime)"
    exit 3
fi
log_info "✅ Stapled"

# ---- Step 3: 验证 ----
log_step "Step 3/3: 验证"
if [[ "$IS_DMG" == "1" ]]; then
    # DMG: 挂载后验证内部 .app
    log_info "  验证 DMG 内 .app 的 Gatekeeper 接受度..."
    MOUNT_POINT=$(mktemp -d)
    if hdiutil attach "$TARGET" -mountpoint "$MOUNT_POINT" -nobrowse -quiet; then
        INNER_APP=$(find "$MOUNT_POINT" -maxdepth 3 -name "*.app" | head -1)
        if [[ -n "$INNER_APP" ]]; then
            spctl -a -t exec -vvv "$INNER_APP" 2>&1 | head -10
        fi
        hdiutil detach "$MOUNT_POINT" -quiet
    fi
else
    # APP: 直接 spctl 验证
    spctl -a -t exec -vvv "$TARGET" 2>&1 | head -10
fi

# xcrun 自带验证
xcrun stapler validate "$TARGET"
log_info "✅ Stapler validation passed"

# notarytool info 查 ticket
SUBMISSION_ID=$(xcrun notarytool history "${AUTH_ARGS[@]}" 2>/dev/null | head -1 | awk '{print $1}' || true)
if [[ -n "${SUBMISSION_ID:-}" ]]; then
    log_info "  最新 Submission ID: $SUBMISSION_ID"
    log_info "  后续可查: xcrun notarytool info $SUBMISSION_ID ${AUTH_ARGS[*]}"
fi

log_info "✅ 全部完成: $TARGET 已公证 + 装订 + 验证通过"
log_info "  可以分发了。安装方式: open \"$TARGET\" 或挂载 DMG 后拖入 Applications"

# ---- 清理 ----
rm -f "$SUBMIT_LOG"
exit 0
