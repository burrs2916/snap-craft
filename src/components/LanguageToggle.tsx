import { useI18n, t } from '../i18n';

/**
 * 右上角中英文切换按钮（参考 biosphere-terminal-app 的 Header 切换设计）。
 * 按钮文字显示「将要切换到的语言」名称（🌐 + 目标语言名），点击即在中/英之间切换，并持久化到 localStorage。
 */
export function LanguageToggle() {
  const { lang, toggleLang } = useI18n();
  const isZh = lang === 'zh-CN';
  // 显示目标语言名称（参考 biosphere-terminal-app：🌐 + 目标语言名，而非缩写代码）
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
