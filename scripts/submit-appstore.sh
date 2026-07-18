#!/usr/bin/env bash
# =============================================================================
# SnapCraft App Store 审核提交脚本
# =============================================================================
#
# 用途:
#   把 Tauri 2 构建出的 macOS .pkg 提交到 App Store Connect,
#   触发 Apple 审核流程(Waiting for Review → In Review → Ready for Sale)。
#
# 前置条件:
#   1. T-M1-02 已完成:Apple Developer 账号 + App Store Connect App + Team ID
#   2. T-M1-04 已完成:Info.plist 完善
#   3. T-M1-08 已完成:PrivacyInfo.xcprivacy 写好
#   4. T-M1-10 已完成:Apple Distribution 证书 + Keychain Profile
#   5. T-M1-12 已完成:App Store Connect 元数据全部填好
#   6. Tauri 已构建出 .pkg:
#      pnpm tauri build --bundles app
#      # 或: pnpm tauri build --target universal-apple-darwin
#      # 产物: src-tauri/target/release/bundle/macos/SnapCraft.pkg
#
# 用法:
#   # 1. 上传到 App Store(走 altool,需 Apple ID 密码)
#   ./scripts/submit-appstore.sh --pkg src-tauri/target/release/bundle/macos/SnapCraft.pkg \
#     --apple-id "your@email.com" \
#     --app-password "abcd-efgh-ijkl-mnop" \
#     --team-id "A1B2C3D4E5"
#
#   # 2. 推荐:用 API Key 认证(CI 友好)
#   ./scripts/submit-appstore.sh --pkg SnapCraft.pkg \
#     --api-key ~/private_keys/AuthKey_2X9R4HXF34.p8 \
#     --api-key-id 2X9R4HXF34 \
#     --api-issuer 57246542-96fe-1a63-e053-0824d011072a
#
#   # 3. 验证 .pkg 是否就绪(不实际上传)
#   ./scripts/submit-appstore.sh --validate-only --pkg SnapCraft.pkg \
#     --apple-id "..." --app-password "..." --team-id "..."
#
#   # 4. 高阶:用 Transporter CLI(更稳,Apple 推荐)
#   xcrun iTMSTransporter -m upload -u "your@email.com" -p "..." \
#     -f metadata.xml -t ~/Library/Caches/com.apple.Transporter/
#
# 退出码:
#   0  成功(已上传)
#   1  参数错误 / 环境问题
#   2  验证失败(.pkg 不合规)
#   3  上传失败(网络 / 凭据)
# =============================================================================

set -euo pipefail

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] [INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] [WARN]${NC} $1"; }
log_error() { echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] [STEP]${NC} $1"; }

# ---- 默认 ----
PKG=""
APPLE_ID=""
APP_PASSWORD=""
TEAM_ID=""
API_KEY=""
API_KEY_ID=""
API_ISSUER=""
VALIDATE_ONLY=0
DRY_RUN=0
VERBOSE=0
AUTO_RELEASE=0   # 审核通过后自动发布(默认手动)

# ---- 参数 ----
usage() {
    sed -n '4,/^# ====/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^$/d'
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pkg|-p)              PKG="$2"; shift 2;;
        --apple-id)            APPLE_ID="$2"; shift 2;;
        --app-password)        APP_PASSWORD="$2"; shift 2;;
        --team-id)             TEAM_ID="$2"; shift 2;;
        --api-key)             API_KEY="$2"; shift 2;;
        --api-key-id)          API_KEY_ID="$2"; shift 2;;
        --api-issuer)          API_ISSUER="$2"; shift 2;;
        --validate-only)       VALIDATE_ONLY=1; shift;;
        --auto-release)        AUTO_RELEASE=1; shift;;
        --dry-run)             DRY_RUN=1; shift;;
        --verbose|-v)          VERBOSE=1; shift;;
        -h|--help)             usage;;
        *)                     log_error "未知参数: $1"; usage;;
    esac
done

# ---- 前置校验 ----
if [[ -z "$PKG" ]]; then
    log_error "未指定 --pkg"
    usage
fi

if [[ ! -f "$PKG" ]]; then
    log_error ".pkg 不存在: $PKG"
    exit 1
fi

if [[ "$(uname)" != "Darwin" ]]; then
    log_error "此脚本仅在 macOS 上运行(当前: $(uname))"
    exit 1
fi

# 校验认证方式
USE_API_KEY=0
if [[ -n "$API_KEY" && -n "$API_KEY_ID" && -n "$API_ISSUER" ]]; then
    USE_API_KEY=1
    log_info "认证: App Store Connect API Key ($API_KEY_ID)"
    [[ ! -f "$API_KEY" ]] && { log_error "API Key 文件不存在: $API_KEY"; exit 1; }
elif [[ -n "$APPLE_ID" && -n "$APP_PASSWORD" && -n "$TEAM_ID" ]]; then
    log_info "认证: Apple ID ($APPLE_ID) + Team $TEAM_ID"
else
    log_error "必须提供认证信息: --api-key/--api-key-id/--api-issuer 或 --apple-id/--app-password/--team-id"
    usage
fi

# ---- 工具检查 ----
for tool in xcrun; do
    command -v "$tool" >/dev/null 2>&1 || { log_error "未找到 $tool,需安装 Xcode Command Line Tools"; exit 1; }
done

# altool 在 Xcode 14+ 已 deprecated,仍可用但警告;Transporter 是新官方方式
# 优先 altool(简单),失败时提示用 Transporter
if ! xcrun altool --help >/dev/null 2>&1; then
    log_warn "未找到 xcrun altool,降级为 Transporter 模式"
    USE_TRANSPORTER=1
else
    USE_TRANSPORTER=0
fi

# ---- 准备认证参数 ----
AUTH_ARGS=()
if [[ "$USE_API_KEY" == "1" ]]; then
    AUTH_ARGS+=("--apiKey" "$API_KEY" "--apiIssuer" "$API_ISSUER")
    # altool 用 --apiKey + --apiIssuer
else
    AUTH_ARGS+=("--username" "$APPLE_ID" "--password" "$APP_PASSWORD")
fi

# ---- Step 1: 验证 .pkg ----
log_step "Step 1/3: 验证 .pkg 元数据"
log_info "  .pkg: $PKG"
log_info "  大小: $(du -h "$PKG" | cut -f1)"

if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] xcrun altool --validate-app -f \"$PKG\" ${AUTH_ARGS[*]} --team-id $TEAM_ID --output-format xml"
    log_info "[DRY-RUN] 跳过验证(DRY-RUN)"
elif [[ "$USE_TRANSPORTER" == "1" ]]; then
    # Transporter 走 validate 模式
    log_warn "Transporter 模式:跳过独立 validate 步骤(在 upload 时自动验证)"
else
    # altool 验证
    if ! xcrun altool --validate-app \
        -f "$PKG" \
        "${AUTH_ARGS[@]}" \
        --team-id "$TEAM_ID" \
        --output-format xml 2>&1 | tee /tmp/snapcraft-validate.log; then
        if [[ "$USE_API_KEY" == "1" ]]; then
            log_error "❌ .pkg 验证失败(API Key 模式)"
        else
            log_error "❌ .pkg 验证失败(Apple ID 模式)"
        fi
        log_error "  详细错误见: /tmp/snapcraft-validate.log"
        log_warn "  常见原因: 1) Apple Distribution 证书未匹配 2) Info.plist 缺关键字段 3) Bundle ID 与 App Store Connect 不一致"
        exit 2
    fi
    log_info "✅ .pkg 元数据验证通过"
fi

# ---- Step 2: 上传 ----
if [[ "$VALIDATE_ONLY" == "1" ]]; then
    log_info "仅验证模式(--validate-only),不实际上传"
    exit 0
fi

log_step "Step 2/3: 上传到 App Store Connect"
log_warn "  上传过程可能 5-15 分钟,取决于 .pkg 大小与网络"

if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] xcrun altool --upload-app -f \"$PKG\" ${AUTH_ARGS[*]} --team-id $TEAM_ID"
    log_info "[DRY-RUN] 跳过实际上传"
    exit 0
fi

UPLOAD_LOG=/tmp/snapcraft-upload-$(date +%Y%m%d-%H%M%S).log
log_info "  详细日志: $UPLOAD_LOG"

if [[ "$USE_TRANSPORTER" == "1" ]]; then
    # Transporter CLI
    if ! command -v iTMSTransporter >/dev/null 2>&1; then
        # Transporter 可能在 Xcode app 包内
        TRANSPORTER_PATH=$(find /Applications/Xcode.app -name "iTMSTransporter" 2>/dev/null | head -1)
        if [[ -z "$TRANSPORTER_PATH" ]]; then
            log_error "未找到 iTMSTransporter CLI,需安装 Transporter app (https://apps.apple.com/app/transporter/id1450874784)"
            exit 3
        fi
        log_info "找到 Transporter: $TRANSPORTER_PATH"
    fi
    log_warn "Transporter 需 metadata.xml 和 .itmsp 目录结构,本脚本未生成,请参考 Apple 文档手动操作"
    log_warn "改用 xcrun altool 上传(若可用)"
    USE_TRANSPORTER=0
fi

if [[ "$USE_TRANSPORTER" == "0" ]]; then
    # altool 上传
    if ! xcrun altool --upload-app \
        -f "$PKG" \
        "${AUTH_ARGS[@]}" \
        --team-id "$TEAM_ID" \
        --output-format xml 2>&1 | tee "$UPLOAD_LOG"; then
        log_error "❌ 上传失败"
        log_error "  详细错误见: $UPLOAD_LOG"
        log_warn "  常见原因: 1) Apple ID 密码错误(需 App-Specific Password) 2) 网络问题 3) 构建版本号已存在"
        exit 3
    fi
fi

# 检查上传结果
UPLOAD_RESULT=$(grep -E "Upload succeeded|Upload failed|No errors uploading" "$UPLOAD_LOG" | tail -1 || echo "")
if echo "$UPLOAD_RESULT" | grep -qE "(Upload succeeded|No errors)"; then
    log_info "✅ 上传成功"
    # 解析版本号
    UPLOADED_VERSION=$(grep -oE "version.{0,50}code.{0,50}\"[^\"]+\"" "$UPLOAD_LOG" | head -1 || echo "")
    if [[ -n "$UPLOADED_VERSION" ]]; then
        log_info "  已上传版本: $UPLOADED_VERSION"
    fi
else
    log_warn "无法从日志识别上传结果(可能为长输出),请检查: $UPLOAD_LOG"
fi

# ---- Step 3: 后续操作提示 ----
log_step "Step 3/3: 后续步骤"
cat <<EOF
✅ .pkg 已上传到 App Store Connect

下一步:
1. 打开 App Store Connect: https://appstoreconnect.apple.com
2. 我的 App → SnapCraft → TestFlight 或 App Store 版本标签
3. 选择刚上传的构建 (Build) → "添加以供审核"
4. 填写"版本"信息(版本号、版权、登录要求等)
5. 在"App 审核信息"中填:
   - 演示账号 (若有登录功能)
   - 联系方式
   - 审核备注(说明功能 + 沙箱限制)
6. 点"提交以供审核" → 状态变为 "Waiting for Review"

审核周期:通常 24-72 小时(首次提交可能 5-7 天)。

${AUTO_RELEASE:+ 备注:--auto-release 已设置,需在 App Store Connect 后台勾选"自动发布"}
EOF

# 保存到文件
cat > /tmp/snapcraft-appstore-submit-summary.txt <<SUMMARY
SnapCraft App Store Submit Summary
==================================
Time:        $(date)
.pkg:        $PKG
Size:        $(du -h "$PKG" | cut -f1)
Auth:        $([ "$USE_API_KEY" == "1" ] && echo "API Key ($API_KEY_ID)" || echo "Apple ID ($APPLE_ID)")
Team ID:     ${TEAM_ID:-N/A (API Key 模式隐含)}
Auto-release: ${AUTO_RELEASE}
Log:         $UPLOAD_LOG
SUMMARY
log_info "提交摘要已写入: /tmp/snapcraft-appstore-submit-summary.txt"

log_info "✅ App Store 提交完成"
exit 0
