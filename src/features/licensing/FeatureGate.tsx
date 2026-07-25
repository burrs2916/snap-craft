import type { ReactNode } from 'react';
import type { ProFeature } from './licenseTypes';
import { useLicenseStore } from './licenseStore';

interface FeatureGateProps {
  feature: ProFeature;
  /// Content to render when the feature is unlocked (Pro or trial).
  children: ReactNode;
  /// Optional fallback rendered when the feature is locked. When omitted and
  /// the feature is locked, the gate renders nothing.
  fallback?: ReactNode;
}

/// Conditionally renders children based on the current license status.
/// - Pro users: always render children.
/// - Trial users: always render children (trial = full access).
/// - Free / expired users: render `fallback` if provided, otherwise nothing.
///
/// 注意：必须订阅 `s.status`（对象引用，每次 set 都变），不能只订阅 `s.canUse`
/// （函数引用恒定，会导致状态变化时本组件不重渲染）。
export function FeatureGate({ feature, children, fallback }: FeatureGateProps) {
  const status = useLicenseStore((s) => s.status);
  const canUse = useLicenseStore((s) => s.canUse);
  void status;

  if (canUse(feature)) {
    return <>{children}</>;
  }

  if (fallback !== undefined) {
    return <>{fallback}</>;
  }

  return null;
}
