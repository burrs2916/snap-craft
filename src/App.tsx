import { EnhancedScreenshotApp } from './features/screenshot/EnhancedScreenshotApp';
import { PinWindow } from './features/screenshot/components/PinWindow';
import { RegionOverlay } from './features/screenshot/components/RegionOverlay';
import { WindowOverlay } from './features/screenshot/components/WindowOverlay';
import { EditorWindow } from './features/screenshot/components/EditorWindow';
import { LicenseProvider, UpgradeDialog, LicenseBadge } from './features/licensing';
import './features/licensing/licensing.css';

function App() {
  // 钉图浮窗以独立窗口加载同一 SPA，通过 hash 区分渲染
  let content;
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#pin')) {
    content = <PinWindow />;
  }
  // 独立编辑窗：每个截图一个独立窗口，可同时开多个
  else if (typeof window !== 'undefined' && window.location.hash.startsWith('#editor')) {
    content = <EditorWindow />;
  }
  // 剪贴板取字独立窗：自己读剪贴板（文字/图片），可多开
  else if (typeof window !== 'undefined' && window.location.hash.startsWith('#clipboard-ocr')) {
    content = <EditorWindow />;
  }
  // 区域截图覆盖层（Windows/Linux 专用，独立全屏窗口）
  else if (typeof window !== 'undefined' && window.location.hash.startsWith('#region-overlay')) {
    content = <RegionOverlay />;
  }
  // 窗口点选覆盖层（Windows/Linux 专用）
  else if (typeof window !== 'undefined' && window.location.hash.startsWith('#window-overlay')) {
    content = <WindowOverlay />;
  } else {
    content = <EnhancedScreenshotApp />;
  }

  return (
    <LicenseProvider>
      {content}
      <LicenseBadge />
      <UpgradeDialog />
    </LicenseProvider>
  );
}

export default App;
