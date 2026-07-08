import { EnhancedScreenshotApp } from './features/screenshot/EnhancedScreenshotApp';
import { CaptureOverlay } from './features/screenshot/components/CaptureOverlay';

function App() {
  // 区域截图覆盖层以独立窗口加载同一 SPA，通过 hash 区分渲染
  if (typeof window !== 'undefined' && window.location.hash === '#capture-overlay') {
    return <CaptureOverlay />;
  }
  return <EnhancedScreenshotApp />;
}

export default App;
