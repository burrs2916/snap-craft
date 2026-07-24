// src/shared/index.ts
// 共享层统一出口：平台检测、几何计算、Markdown 解析。
// 外部模块应从 shared 导入，而非直接引用内部文件路径。

export * from './platform';
export * from './geometry';
export * from './markdownParse';
