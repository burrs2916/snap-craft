# OCR 功能复盘报告（2026-07-14）

针对已落地的 OCR 全链路（R1–R4 / N1 / N2 上下 / R4 增强 / 历史 OCR 搜索 / N3 多区域 / N4 长图分块）做系统性空实现/bug 扫描。

## 扫描方法
- 实际读代码（非凭记忆）：`EditorWindow.tsx`、`EnhancedScreenshotApp.tsx`、`index.css`、两份 locale。
- 信号扫描：`console.log` / `debugger` / `TODO` / `FIXME` / `stub` / `空实现` / `未实现` → **零命中**，无调试残留、无空 stub。
- 逐功能核对数据流与坐标映射。

## 结论：整体健康，发现并修复 1 个真实 bug

### ✅ 已确认正确（非 bug）
| 项 | 结论 |
|----|------|
| N4 分块坐标映射 `mapBlockToFull` | 数学正确：x/w 不变，y/h 按块高缩放回整图 |
| N4 `runTiledOcr` | 串行切块 + 单块失败不中断，正确 |
| R4 批量编辑 | textarea 写回 `batchItems`，复制全部/导出用 `batchItems.map(i=>i.text)`，编辑即时生效 |
| 历史搜索 | `filteredHistory` 正确驱动网格 + 空态双分支（无历史 vs 无匹配） |
| `clearSel` | 复位 `selIds/selMode/showBatch/batchItems` 完整 |
| i18n | N2/N3/R4增强/历史搜索 全部新增键在 zh-CN & en-US **均齐备**，无缺键 |
| 区域预览 | `ocrRegionPreview` 有渲染；`AnnotationCanvas` 收到 `ocrRegionMode`（多区域保持选区） |
| 死代码 | `openEditor`/`openHistory`/`startOcrFromClipboard`/`currentView==='edit'` 仅保留定义、无调用点 → **按项目约定有意保留，非缺陷** |

### 🐞 修复的真实 bug：N4 `dedupeBlocks` 误合并 / 漏删
**原实现问题**
```ts
// 只与「阅读序相邻前一元素」比较，且 y 阈值宽松(2%)
if (last && last.text.trim() === b.text.trim() && Math.abs(last.y - b.y) < 0.02) continue;
```
1. 重叠区重复行经阅读序重排后若**不相邻则漏删** → 残留重复行。
2. 列表里**重复文字行**（如多项「完成」）若垂直间距 <2% 被**误合并成一行 → 静默丢行**（数据丢失）。

**修复**
```ts
// 与所有已保留块比较，阈值收紧到 0.5%/2%（重叠区重复行映射后仅 OCR 抖动差异，远小于真实行间距）
const dup = out.find(
  (p) => p.text.trim() === b.text.trim() &&
         Math.abs(p.y - b.y) < 0.005 &&
         Math.abs(p.x - b.x) < 0.02,
);
if (!dup) out.push(b);
```

## 验证
- `pnpm build` → exit 0（126 模块），`tsc` 零类型错误。
- 纯前端改动，但前几轮动过 Rust，**重启 App 生效**：`./start.sh dev` 或 `pnpm build && ./start.sh app`。

## 遗留（有意，非缺陷）
- in-page 编辑器（`currentView==='edit'` 等）为死代码，按本项目「保留不删、安全回退」约定保留。
- `selectAll` 在搜索过滤激活时用的是 `history`（全部）而非 `filteredHistory`，属轻微 UX 不一致，不影响功能，未改。
