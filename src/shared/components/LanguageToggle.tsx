// ===== 语言切换按钮（共享组件） =====
// 右上角中英文切换按钮。按钮文字显示「将要切换到的语言」名称，
// 点击即在中/英之间切换，并持久化到 localStorage。
//
// 2026-07-24 从 src/components/ 迁移至 src/shared/components/，
// 作为跨 feature 共享的 UI 组件。

import { useI18n, t } from '../../i18n';

export function LanguageToggle() {
  const { lang, toggleLang } = useI18n();
  const isZh = lang === 'zh-CN';
  const nextLabel = isZh ? t('lang.en') : t('lang.zh');
  const title = isZh ? t('lang.toggleToEn') : t('lang.toggleToZh');

  return (
    <button
      className="lang-toggle"
      type="button"
      title={title}
      aria-label={title}
      onClick={toggleLang}
    >
      <span className="lang-toggle-globe" aria-hidden="true">🌐</span>
      <span className="lang-toggle-text">{nextLabel}</span>
    </button>
  );
}

export default LanguageToggle;
