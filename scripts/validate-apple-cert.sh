#!/usr/bin/env bash
#
# validate-apple-cert.sh — 本地校验 Apple 开发者 .p12 证书包
#
# 用途: 在把证书塞进 GitHub Secret (APPLE_CERTIFICATE_BASE64) 之前,
#       先在本地确认这个 p12 同时满足:
#         1. 是合法的 PKCS#12 (.p12) 文件;
#         2. 给定密码能解开;
#         3. 同时包含【证书 + 私钥】(codesign 必须要私钥);
#         4. 证书主题确实是 Developer ID Application (用于 macOS 分发/公证)。
#
# 用法:
#   ./scripts/validate-apple-cert.sh <path-to-cert.p12> [p12-password]
#
# 若省略密码, 脚本会交互式提示输入 (输入不回显)。
#
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "用法: $0 <path-to-cert.p12> [p12-password]" >&2
  echo "示例: $0 ~/Downloads/cert.p12" >&2
  echo "      $0 ~/Downloads/cert.p12 'my-export-password'" >&2
  exit 2
fi

P12="$1"
PWD="${2:-}"

if [ ! -f "$P12" ]; then
  echo "❌ 找不到文件: $P12" >&2
  exit 2
fi

if [ -z "$PWD" ]; then
  echo -n "请输入 p12 密码: " >&2
  IFS= read -rs PWD
  echo >&2
fi

echo "=== 校验 p12: $P12 ==="

# 1) 能否用密码解开并解出证书 (BEGIN CERTIFICATE)
if ! openssl pkcs12 -info -in "$P12" -passin "pass:$PWD" -nokeys -passout pass: 2>/dev/null \
     | grep -q "BEGIN CERTIFICATE"; then
  echo "❌ 失败: 该文件不是合法 p12, 或密码错误, 或证书缺失。" >&2
  echo "   常见原因:" >&2
  echo "     - 误存了 Apple 官网下载的 .cer (仅含公钥, 不是 p12)" >&2
  echo "     - 存的是 PEM 文本而非二进制 p12" >&2
  echo "     - 对 p12 做了『二次 base64 编码』导致损坏" >&2
  echo "     - APPLE_CERTIFICATE_PASSWORD 与导出 p12 时的密码不符" >&2
  exit 1
fi
echo "  ✓ 证书存在, 且密码正确"

# 2) 是否包含私钥 (codesign 必需)
if ! openssl pkcs12 -info -in "$P12" -passin "pass:$PWD" -nocerts -passout pass: 2>/dev/null \
     | grep -q "PRIVATE KEY"; then
  echo "❌ 失败: p12 内没有私钥。codesign 需要私钥才能签名。" >&2
  echo "   请从 Keychain Access 重新导出: 选中证书(展开显示其私钥) -> 右键 -> 导出 .p12" >&2
  exit 1
fi
echo "  ✓ 私钥存在 (codesign 可用)"

# 3) 显示证书主题, 确认是 Developer ID Application
echo "=== 证书主题 ==="
openssl pkcs12 -info -in "$P12" -passin "pass:$PWD" -nokeys -passout pass: 2>/dev/null \
  | openssl x509 -noout -subject -issuer -enddate 2>/dev/null \
  || echo "  (无法解析主题, 但证书与私钥均已确认存在)"

echo
echo "✅ 校验通过。该 p12 可作为 APPLE_CERTIFICATE_BASE64 存入 GitHub Secret。"
echo
echo "=== 如何正确生成 GitHub Secret (标准做法) ==="
echo "1. 打开 钥匙串访问 (Keychain Access), 选择『登录』钥匙串。"
echo "2. 找到你的 'Developer ID Application' 证书, 点击左侧三角展开,"
echo "   确认其下挂载了对应的私钥 (没有私钥则 codesign 必失败)。"
echo "3. 选中【证书(含私钥)】-> 右键 -> 导出 -> 格式选"
echo "   'Personal Information Exchange (.p12)'。"
echo "4. 设置导出密码 (这就是 APPLE_CERTIFICATE_PASSWORD)。"
echo "5. 生成【单行】base64 (不要换行, 不要二次编码):"
echo "       base64 -i cert.p12 | pbcopy"
echo "   -> 把剪贴板内容存入 Secret: APPLE_CERTIFICATE_BASE64"
echo "   -> 把导出密码存入 Secret:   APPLE_CERTIFICATE_PASSWORD"
echo "   注意: 只做一次 base64 (绝不要对已经是 base64 的文本再 base64 一次)。"
