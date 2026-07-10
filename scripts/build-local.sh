#!/usr/bin/env bash
# 本地构建（无需 Apple 开发者账号）
#
# 用法：
#   pnpm build:local                                          # 等价于 CI：ad-hoc 签名（signingIdentity: "-"）
#   SNAP_SIGN_ID="SnapCraft Local" pnpm build:local         # 用你本机钥匙串里的自签名证书签名
#
# 创建自签名证书（免费，无需 Apple ID）：
#   钥匙串访问 → 证书助理 → 创建证书
#     名称随意（如 SnapCraft Local）
#     身份类型：自签名根证书
#     证书类型：代码签名
#   → 创建，弹出时选「始终信任」。
# 之后把证书名称传给 SNAP_SIGN_ID 即可。Gatekeeper 会因该证书就在你本机
# 登录钥匙串中且被标记为「始终信任」而放行此 App，首次打开不再被拦截。
#
# 实现说明：
#   借助 Tauri build script 支持的 TAURI_CONFIG 环境变量（JSON 深合并）覆盖
#   bundle.macOS.signingIdentity。CI 不调用本脚本、也不设该变量，
#   因此 CI 仍使用 tauri.conf.json 里写死的 "-"（ad-hoc），不受影响。
#
# 注意：本机必须已存在该名称的「代码签名」证书，否则 codesign 阶段会报错。
#       证书名称含空格时直接加引号传参即可（如上面示例）。

set -euo pipefail

SIGN_ID="${SNAP_SIGN_ID:--}"
export TAURI_CONFIG="{\"bundle\":{\"macOS\":{\"signingIdentity\":\"${SIGN_ID}\"}}}"

pnpm tauri build "$@"
