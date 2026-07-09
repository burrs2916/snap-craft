import { EnhancedScreenshotApp } from './features/screenshot/EnhancedScreenshotApp';
import { CaptureOverlay } from './features/screenshot/components/CaptureOverlay';

function App() {
  // 区域截图覆盖层以独立窗口加载同一 SPA，通过 hash 区分渲染。
  // 覆盖层 URL 形如 `/#capture-overlay?mode=region&...`，hash 含 query，
  // 不能用严格相等（=== '#capture-overlay'），否则匹配失败会渲染成主界面。
  if (typeof window !== 'undefined' && window.location.hash.split('?')[0] === '#capture-overlay') {
    return <CaptureOverlay />;
  }
  return <EnhancedScreenshotApp />;
}

export default App;
