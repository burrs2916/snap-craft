import { EnhancedScreenshotApp } from './features/screenshot/EnhancedScreenshotApp';
import { CaptureOverlay } from './features/screenshot/components/CaptureOverlay';
import { PinnedWindow } from './features/screenshot/components/PinnedWindow';

function App() {
  // 多窗口共用同一 SPA，用 hash 区分渲染（hash 可能带 query，用 split 比较）
  const hash = typeof window !== 'undefined' ? window.location.hash.split('?')[0] : '';
  if (hash === '#capture-overlay') return <CaptureOverlay />;
  if (hash === '#pin') return <PinnedWindow />;
  return <EnhancedScreenshotApp />;
}

export default App;
