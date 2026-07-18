import { EnhancedScreenshotApp } from './features/screenshot/EnhancedScreenshotApp';
import { PinWindow } from './features/screenshot/components/PinWindow';
import { RegionOverlay } from './features/screenshot/components/RegionOverlay';
import { WindowOverlay } from './features/screenshot/components/WindowOverlay';
import { EditorWindow } from './features/screenshot/components/EditorWindow';

function App() {
  // 钉图浮窗以独立窗口加载同一 SPA，通过 hash 区分渲染
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#pin')) {
    return <PinWindow />;
  }
  // 独立编辑窗：每个截图一个独立窗口，可同时开多个
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#editor')) {
    return <EditorWindow />;
  }
  // 剪贴板取字独立窗：自己读剪贴板（文字/图片），可多开
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#clipboard-ocr')) {
    return <EditorWindow />;
  }
  // 区域截图覆盖层（Windows/Linux 专用，独立全屏窗口）
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#region-overlay')) {
    return <RegionOverlay />;
  }
  // 窗口点选覆盖层（Windows/Linux 专用）
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#window-overlay')) {
    return <WindowOverlay />;
  }
  return <EnhancedScreenshotApp />;
}

export default App;
