/// License tier reported by the backend.
export type LicenseTier = 'trial' | 'free' | 'pro';

export interface LicenseStatus {
  tier: LicenseTier;
  isPro: boolean;
  isTrial: boolean;
  isExpired: boolean;
  trialDaysRemaining: number;
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  subscriptionExpiresAt: string | null;
  reason: string;
}

/// Pro feature identifiers gated by the license system.
/// 商业模式（与 AI-SnapScribe 定价一致）：
/// - 截屏 / 基础标注 / OCR（系统自带）/ 历史 / PNG / 滚动长截 / 步骤 / 高亮 = 免费
/// - 以下 3 项为 Pro 高级功能：试用期内全开，试用结束后需订阅解锁
export type ProFeature =
  | 'ai' // AI 全部：生成 / 润色 / 智能编辑 / Agent
  | 'export_doc' // 导出 Word / PPT / Excel / PDF（AI 生成文档）
  | 'redact'; // 马赛克 / 高斯模糊 / 涂黑打码
