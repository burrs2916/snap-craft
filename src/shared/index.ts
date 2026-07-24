// src/shared/index.ts
// 共享层统一出口：平台检测、几何计算、Markdown 解析、共享组件。
// 外部模块应从 shared 导入，而非直接引用内部文件路径。
//
// 2026-07-24 目录分层优化：
//   - shared/components/  跨 feature 共享的 UI 组件（LanguageToggle 等）
//   - shared/hooks/       跨 feature 共享的 React hooks
//   - shared/platform.ts  平台检测与跨平台工具函数
//   - shared/geometry.ts  几何计算
//   - shared/markdownParse.ts  Markdown 解析工具

export * from './platform';
export * from './geometry';
export * from './markdownParse';
export { LanguageToggle } from './components/LanguageToggle';
