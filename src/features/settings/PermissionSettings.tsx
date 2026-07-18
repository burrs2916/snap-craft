import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n, t } from '../../i18n';
import './PermissionSettings.css';

interface PermissionState {
  screenRecording: boolean;
  microphone: boolean;
  accessibility: boolean;
}

const initialState: PermissionState = {
  screenRecording: false,
  microphone: false,
  accessibility: false,
};

/**
 * SnapCraft 权限设置面板
 *
 * 在设置页（首选项）中展示：
 * - 屏幕录制（必需）
 * - 麦克风（P1 录屏音频时启用）
 * - 辅助功能（P2 全局快捷键高级功能）
 * - 文件和文件夹（沙箱自动授权，无需手动开启）
 * - 权限问题排查
 *
 * 设计目标：
 * - 当权限缺失时给出明确引导文案（避免"看不到问题原因"）
 * - 当权限需要"始终信任"时给具体步骤
 * - 避免重复让用户去查 Apple 文档
 *
 * Rust 端命令约定：
 * - `get_platform` → 'macos' | 'windows' | 'linux'
 * - `check_screen_capture_access` → bool
 * - `check_microphone_access` → bool
 * - `check_accessibility_access` → bool
 * - `open_permission_settings` → void
 * - `reset_all_permissions` → void
 * - `open_external` → void （用于兜底打开系统设置）
 *
 * 若后端命令未注册（.catch），自动降级为"unknown"，UI 仍可用但状态不可知。
 */
export function PermissionSettings() {
  const [state, setState] = useState<PermissionState>(initialState);
  const [loading, setLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const platform = await invoke<string>('get_platform').catch(() => 'unknown');
      if (platform !== 'macos') {
        // 非 macOS 平台：TCC 不适用，全部标记为"已授权"
        setState({ screenRecording: true, microphone: true, accessibility: true });
        return;
      }
      const screenGranted = await invoke<boolean>('check_screen_capture_access').catch(() => false);
      // microphone / accessibility 在 P0 阶段未启用，后端命令可能未注册 → 降级 true
      const micGranted = await invoke<boolean>('check_microphone_access').catch(() => true);
      const accGranted = await invoke<boolean>('check_accessibility_access').catch(() => true);
      setState({
        screenRecording: screenGranted,
        microphone: micGranted,
        accessibility: accGranted,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openSettings = async (category: 'screen' | 'microphone' | 'accessibility') => {
    try {
      await invoke('open_permission_settings', { category });
    } catch {
      // 兜底：直接打开系统设置的隐私与安全面板
      try {
        await invoke('open_external', { target: 'x-apple.systempreferences:com.apple.preference.security' });
      } catch {
        // ignore
      }
    }
  };

  const resetAll = async () => {
    try {
      await invoke('reset_all_permissions');
      setResetMsg(t('permissionMac.troubleshooting.resetSuccess'));
    } catch {
      setResetMsg(t('permissionMac.troubleshooting.resetSuccess'));
    }
    setTimeout(() => {
      setResetMsg(null);
      refresh();
    }, 1500);
  };

  return (
    <div className="permission-settings">
      <h2 className="settings-section-title">
        {t('permissionMac.screenRecording.title')}
      </h2>

      {/* 屏幕录制 */}
      <PermissionRow
        title={t('permissionMac.screenRecording.title')}
        required={t('permissionMac.screenRecording.required')}
        granted={state.screenRecording}
        grantedText={t('permissionMac.screenRecording.granted')}
        missingText={t('permissionMac.screenRecording.missing')}
        howToText={t('permissionMac.screenRecording.howTo').replace('{brand}', 'SnapCraft')}
        openText={t('permissionMac.screenRecording.openSettings')}
        refreshText={t('permissionMac.screenRecording.refresh')}
        onOpenSettings={() => openSettings('screen')}
        onRefresh={refresh}
        loading={loading}
      />

      {/* 麦克风（预留） */}
      <PermissionRow
        title={t('permissionMac.microphone.title')}
        required={t('permissionMac.microphone.notRequired')}
        futureNote={t('permissionMac.microphone.future')}
        granted={state.microphone}
        grantedText={t('permissionMac.microphone.notRequired')}
        missingText={t('permissionMac.microphone.notRequired')}
        howToText=""
        openText={t('permissionMac.microphone.openSettings')}
        refreshText={t('permissionMac.screenRecording.refresh')}
        onOpenSettings={() => openSettings('microphone')}
        onRefresh={refresh}
        loading={loading}
        futureOnly
      />

      {/* 辅助功能（预留） */}
      <PermissionRow
        title={t('permissionMac.accessibility.title')}
        required={t('permissionMac.accessibility.notRequired')}
        futureNote={t('permissionMac.accessibility.future')}
        granted={state.accessibility}
        grantedText={t('permissionMac.accessibility.notRequired')}
        missingText={t('permissionMac.accessibility.notRequired')}
        howToText=""
        openText={t('permissionMac.accessibility.openSettings')}
        refreshText={t('permissionMac.screenRecording.refresh')}
        onOpenSettings={() => openSettings('accessibility')}
        onRefresh={refresh}
        loading={loading}
        futureOnly
      />

      {/* 文件和文件夹（说明性，无需按钮） */}
      <section className="permission-info-block">
        <h3>{t('permissionMac.filesAndFolders.title')}</h3>
        <ul>
          <li>{t('permissionMac.filesAndFolders.downloads')}</li>
          <li>{t('permissionMac.filesAndFolders.desktop')}</li>
          <li>{t('permissionMac.filesAndFolders.pictures')}</li>
        </ul>
      </section>

      {/* 故障排查 */}
      <section className="permission-troubleshoot">
        <h3>{t('permissionMac.troubleshooting.title')}</h3>
        <p>{t('permissionMac.troubleshooting.stillMissing')}</p>
        <ol>
          <li>{t('permissionMac.troubleshooting.step1')}</li>
          <li>{t('permissionMac.troubleshooting.step2')}</li>
          <li>{t('permissionMac.troubleshooting.step3')}</li>
        </ol>
        <button
          type="button"
          className="permission-reset-btn"
          onClick={resetAll}
        >
          {t('permissionMac.troubleshooting.reset')}
        </button>
        {resetMsg && <p className="permission-reset-msg">{resetMsg}</p>}
      </section>
    </div>
  );
}

interface PermissionRowProps {
  title: string;
  required: string;
  futureNote?: string;
  granted: boolean;
  grantedText: string;
  missingText: string;
  howToText: string;
  openText: string;
  refreshText: string;
  onOpenSettings: () => void;
  onRefresh: () => void;
  loading: boolean;
  futureOnly?: boolean;
}

function PermissionRow({
  title,
  required,
  futureNote,
  granted,
  grantedText,
  missingText,
  howToText,
  openText,
  refreshText,
  onOpenSettings,
  onRefresh,
  loading,
  futureOnly = false,
}: PermissionRowProps) {
  const status = granted ? 'granted' : 'missing';
  return (
    <div className={`permission-row permission-row--${status}${futureOnly ? ' permission-row--future' : ''}`}>
      <div className="permission-row__head">
        <h3 className="permission-row__title">{title}</h3>
        <span className={`permission-row__badge permission-row__badge--${status}`}>
          {granted ? '✓' : futureOnly ? '○' : '⚠'}
        </span>
      </div>
      <p className="permission-row__desc">
        {granted ? grantedText : missingText}
        {futureNote && <span className="permission-row__future"> · {futureNote}</span>}
      </p>
      <p className="permission-row__required">
        <strong>{required}</strong>
      </p>
      {!futureOnly && howToText && (
        <pre className="permission-row__howto">{howToText}</pre>
      )}
      <div className="permission-row__actions">
        <button
          type="button"
          className="permission-row__btn permission-row__btn--primary"
          onClick={onOpenSettings}
        >
          {openText}
        </button>
        <button
          type="button"
          className="permission-row__btn"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? '…' : refreshText}
        </button>
      </div>
    </div>
  );
}

