# SnapCraft Apple Developer 账号申请与配置指南

> 目标:让 SnapCraft 0.1.0 通过 macOS App Store 审核上架,获得稳定的代码签名 + 公证 + 公证回执链路。
>
> **预计耗时**:首 1-3 天(账号审核 24-48 小时,公司主体需 2-3 周)。

---

## 1. 注册 Apple Developer Program

### 1.1 个人开发者 vs 公司主体

| 维度 | 个人 (Individual) | 公司 (Organization) |
|------|------|------|
| **费用** | $99 USD/年 | $99 USD/年 |
| **审核时长** | 通常 24-48 小时 | 首次需 2-3 周(邓白氏编码 + 法人核验) |
| **Bundle ID 数量** | 100 个 | 100 个 |
| **Team ID 数量** | 1 个 | 1 个 |
| **App Store 显示** | 开发者姓名 | 公司名 |
| **适用** | 独立开发者/早期产品 | 中后期商业化 |

**SnapCraft 建议**:先以**个人开发者**身份上架,1.0 稳定后再切公司主体(需 D-U-N-S 编码)。

### 1.2 注册步骤

1. 打开 https://developer.apple.com/programs/enroll/
2. 用现有 Apple ID 登录(没有就创建一个,**这个 Apple ID 将成为 Team Agent**)
3. 选择账号类型:
   - **Individual / Sole Proprietorship / Single Person LLC** → 个人路径
   - **Organization** → 公司路径(需 D-U-N-S Number)
4. 填写个人/公司信息(姓名、地址、电话、邮箱)
5. 同意《Apple Developer Program License Agreement》
6. 支付 $99 USD(用 Apple ID 绑定的支付方式,信用卡 / Apple Pay / PayPal)
7. 等待审核邮件(个人通常 24-48h,公司 2-3 周)
8. 审核通过后,收到 "Welcome to the Apple Developer Program" 邮件

### 1.3 关键信息记录

审核通过后,在 **App Store Connect** (https://appstoreconnect.apple.com) 记录:

| 项 | 值 | 用途 |
|----|----|------|
| **Apple ID** | `yourname@example.com` | 登录 App Store Connect / Developer Portal |
| **Team ID** | 10 位字母数字(如 `A1B2C3D4E5`) | 标识开发者团队的全局唯一 ID;签名时必填 |
| **Team Agent** | 注册时填写的姓名 | 唯一可转让 Team / 删除 App 的账号;离职前需交接 |
| **Bundle ID** | `com.snap-craft.app` | 应用的全球唯一标识;**不可改,一旦上架永远不变** |

**查看方式**:
- https://developer.apple.com/account → Membership → Team ID
- App Store Connect → Users and Access → 我自己的信息

---

## 2. App Store Connect 后台配置

### 2.1 创建 App 记录

1. 登录 https://appstoreconnect.apple.com
2. 我的 App → `+` → **新建 App**
3. 填写:
   - **平台**:macOS(必选,可不选 iOS)
   - **名称**:SnapCraft(全 App Store 唯一,不能与已上架 App 重名)
   - **主要语言**:Simplified Chinese(后续可加 6 语言)
   - **Bundle ID**:`com.snap-craft.app`(已注册,下拉选)
   - **SKU**:`snap-craft-001`(内部标识,审核员看不到)
   - **用户访问权限**:启用
4. 创建后,记录:
   - **App Store Connect App ID**(数字 ID,如 `1234567890`)
   - **Apple ID**(创建 App 时用的那个 Apple ID)

### 2.2 团队成员管理(可选,前期单人开发可跳)

- 我的 App → Users and Access → 邀请协作者
- 角色:Admin(全部权限)/ App Manager(不能管用户)/ Developer(只读 + 上传)
- 至少邀请一位 **Admin** 备份,避免 Team Agent 离职后无法管理

---

## 3. 申请代码签名证书

### 3.1 需要哪几种证书

| 证书类型 | 用途 | 申请位置 | SnapCraft 是否需要 |
|---------|------|----------|------------------|
| **Apple Development** | 本地调试 / 真机运行 | Certificates → Development | ❌ (SnapCraft 不连 iOS 设备) |
| **Developer ID Application** | 开发者签名 + 公证(直接分发) | Certificates → Production → Developer ID | ❌ (App Store 上架不用这个) |
| **Apple Distribution** | App Store / TestFlight 签名 | Certificates → Production | ✅ **M1 必须** |
| **Mac Installer Distribution** | .pkg 签名(可选) | Certificates → Production | ⚠️ 仅当我们改用 .pkg 而非 .dmg 时 |

**结论**:App Store 上架只需要 **Apple Distribution** 证书,Developer ID 证书是开发者网站直接分发(.dmg 直链下载)用的。

### 3.2 在 Xcode 里自动申请(推荐,最简单)

1. 打开 Xcode → Settings → Accounts
2. 点击 `+` → Apple ID → 用你的 Apple ID 登录
3. 选中该账号 → 点击 **Manage Certificates...** → `+` → **Apple Distribution**
4. Xcode 会自动调用 `certSigningRequest` 生成 CSR,提交 Apple Developer 后台,下载 .cer 导入钥匙串
5. 完成后,钥匙串访问 → 我的证书 → 能看到 "Apple Distribution: 你的名字 (Team ID)"

### 3.3 手动申请(无 Xcode 时的兜底)

1. 钥匙串访问 → 证书助理 → 从证书颁发机构请求证书...
2. 填写:
   - 用户电子邮件地址:你的 Apple ID 邮箱
   - 常用名称:SnapCraft CI(可任意,用于区分)
   - 请求是: **存储到磁盘**
3. 保存 `CertificateSigningRequest.certSigningRequest` 到本地
4. 去 https://developer.apple.com/account/resources/certificates/add
5. 选择 **Apple Distribution** → 选择 CSR 文件 → 确认
6. 下载 `apple_distribution.cer`,双击导入钥匙串
7. (可选)导出为 .p12 给 CI 用:
   - 钥匙串访问 → 我的证书 → 找到 "Apple Distribution: ..." → 右键 导出
   - 文件格式:**个人信息交换(.p12)**
   - 设置密码(给 CI 用)

### 3.4 CI 环境下的证书管理

CI 机器(macOS runner)需要:
1. 私钥(从 .p12 解出)
2. Apple Distribution 证书
3. **Team ID**
4. App Store Connect API Key(见 §4)

**推荐方式**:用 Xcode 自动管理 + 临时密钥链(`keychain.sh` 脚本,见 `build/macos/` 目录)。**不要**把 .p12 提交到 Git 仓库。

---

## 4. App Store Connect API Key(公证必需)

公证脚本用 `xcrun notarytool`,需通过 API Key 或 Apple ID 密码认证。
**API Key 是推荐方式**——比 Apple ID 密码更安全、可吊销、CI 友好。

### 4.1 生成 API Key

1. 打开 https://appstoreconnect.apple.com/access/integrations/api
2. 点 `+` → **生成 API 密钥**:
   - 名称:`SnapCraft Notary`(用于辨识)
   - 访问权限:**Developer**(足够公证)
3. 创建后,**只能下载一次** `.p8` 文件(Issuer ID + Key ID + .p8)
4. 记录三项:
   - **Issuer ID**(UUID 格式,如 `57246542-96fe-1a63-e053-0824d011072a`)
   - **Key ID**(10 位字母数字,如 `2X9R4HXF34`)
   - **.p8 文件**(如 `AuthKey_2X9R4HXF34.p8`)

### 4.2 在 CI 存为 Secret

GitHub Actions 仓库 → Settings → Secrets and variables → Actions:

| Secret 名称 | 内容 |
|------------|------|
| `APPLE_API_KEY` | `.p8` 文件完整内容(粘贴 PEM 文本) |
| `APPLE_API_KEY_ID` | Key ID(如 `2X9R4HXF34`) |
| `APPLE_API_ISSUER` | Issuer ID(UUID) |
| `APPLE_TEAM_ID` | 你的 Team ID(10 位字符) |
| `APPLE_CERTIFICATE` | base64 编码的 .p12 内容(`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 的密码 |

> ⚠️ 旧版 `APPLE_ID` + `APPLE_PASSWORD` 走两步验证,易失败,新项目推荐 API Key。

### 4.3 本地测试

```bash
# 把 .p8 存到 ~/private_keys/
mkdir -p ~/private_keys
cp ~/Downloads/AuthKey_2X9R4HXF34.p8 ~/private_keys/

# 一次性存到本地钥匙串
xcrun notarytool store-credentials "snapcraft-notary" \
  --key ~/private_keys/AuthKey_2X9R4HXF34.p8 \
  --key-id 2X9R4HXF34 \
  --issuer 57246542-96fe-1a63-e053-0824d011072a
# 之后 notarytool --keychain-profile "snapcraft-notary" 即可使用
```

---

## 5. 在 SnapCraft 项目中固化配置

完成上述步骤后,把以下值写进 `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "macOS": {
      "entitlements": "Entitlements.plist",
      "infoPlist": "Info.plist",
      "signingIdentity": "Apple Distribution: 你的名字 (TEAMID)",
      "providerShortName": "TEAMID",
      "hardenedRuntime": true,
      "minimumSystemVersion": "14.0"
    }
  }
}
```

> ⚠️ `signingIdentity` **只在 App Store 上架构建时**才设;dev 构建(`./start.sh dev`)仍用本地自签名(`-` 或 `SnapCraft Local`)。

**两套签名方案并存的策略**:
- **dev** (`./start.sh dev`):用本地自签名 `SnapCraft Local` → TCC 授权跨重编保留
- **prod** (CI / `./start.sh build-tauri`):用 Apple Distribution + Hardened Runtime + 公证
- 切换靠环境变量 `SNAP_SIGN_ID`(空 = ad-hoc / `-` = 默认 / 具体名称 = 该证书)

---

## 6. 验证清单

完成上述所有步骤后,确认:

- [ ] 登录 https://developer.apple.com/account → Membership 显示 **Apple Developer Program**(有效期至明年)
- [ ] 记录了 **Apple ID**、**Team ID**(10 位)
- [ ] 钥匙串里有 **Apple Distribution: 你的名字 (TEAMID)** 证书
- [ ] App Store Connect 里有 `com.snap-craft.app` 这个 Bundle ID
- [ ] App Store Connect → 我的 App → SnapCraft 已创建(状态:Prepare for Submission)
- [ ] App Store Connect API Key 已生成,Issuer ID + Key ID + .p8 都已下载
- [ ] CI Secrets 已配齐(`APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` / `APPLE_TEAM_ID` / `APPLE_CERTIFICATE` + 密码)

---

## 7. 常见问题

### Q1:Apple ID 已被别人用作 Team Agent,怎么办?
**A**:每个 Apple ID 只能作为一个 Developer Program 团队的 Team Agent。要么换一个新的 Apple ID 申请(不推荐,会被拒),要么联系原 Team Agent 把 Agent 角色转给你(走 Developer Support)。

### Q2:Bundle ID 在 App Store Connect 已被占用?
**A**:App Store Connect 允许相同 Bundle ID 在不同团队下注册(每个团队独立)。如果是同团队下重复,先删除旧的。

### Q3:公证一直超时?
**A**:Apple 公证服务正常 5-15 分钟,高峰可能 30 分钟+。若超过 1 小时,到 https://developer.apple.com/account → 见 "Notarization Activity Log" 看历史状态。

### Q4:Apple Distribution 证书过期了?
**A**:证书每年需续期(过期前 Apple 会邮件提醒)。CI 上要么改用新 .p12,要么改成在构建时调用 `certbot` 式脚本自动下载新证书。**建议**:用 App Store Connect API Key + Fastlane match 自动管理。

### Q5:Team ID 在哪看?
**A**:
- App Store Connect → 我的 App → 选中 SnapCraft → App 信息 → 顶部 "Apple ID" 行末尾的 10 位字符
- 或:https://developer.apple.com/account → Membership → Team ID

### Q6:可以团队多人共用一个 Apple ID 吗?
**A**:Apple 官方不推荐,但实践可行:
- 用一个 Apple ID 注册 Program → 拿 Team ID
- 其他人通过 App Store Connect → Users and Access 邀请加入(分配 Developer / App Manager 角色)
- 上架审核邮件 / 通知会发到该 Apple ID(建议加多人邮箱转发)

---

## 8. 下一步

完成本指南的全部步骤后,继续:
- T-M1-03 改 `tauri.conf.json`(补 `hardenedRuntime` / `minimumSystemVersion` / `providerShortName`)
- T-M1-10 写公证脚本
- T-M1-13 写 App Store 提交脚本
- T-M1-12 准备元数据(截图、描述、关键词、隐私 URL)

---

**参考文档**:
- Apple Developer Program 注册:https://developer.apple.com/programs/enroll/
- App Store Connect 帮助:https://developer.apple.com/help/app-store-connect/
- 证书管理:https://developer.apple.com/help/account/manage-certificates/
- Notarization 流程:https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution
