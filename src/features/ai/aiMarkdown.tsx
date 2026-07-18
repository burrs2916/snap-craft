// 极简 Markdown 渲染器（零依赖，仅覆盖 AI 输出常用子集）：
// 标题 / 段落 / 有序·无序列表 / 引用 / 分割线 / 代码块，以及行内 **粗体** *斜体* `代码` [链接](url)。
// 不引入第三方库，避免影响现有依赖与构建。

import type { ReactNode, CSSProperties } from 'react';

function renderItalic(text: string, keyPrefix: string): ReactNode[] {
  const italRe = /\*([^*]+)\*/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = italRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<em key={`${keyPrefix}-i${i}`}>{m[1]}</em>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderEmphasis(text: string, keyPrefix: string): ReactNode[] {
  const boldRe = /\*\*([^*]+)\*\*/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > last) out.push(...renderItalic(text.slice(last, m.index), `${keyPrefix}-b${i}`));
    out.push(<strong key={`${keyPrefix}-bold${i}`}>{m[1]}</strong>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(...renderItalic(text.slice(last), `${keyPrefix}-b${i}`));
  return out;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g);
  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (!part) return;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="md-code">
          {part.slice(1, -1)}
        </code>
      );
      return;
    }
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    const segs: ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let li = 0;
    while ((m = linkRe.exec(part)) !== null) {
      if (m.index > last) segs.push(...renderEmphasis(part.slice(last, m.index), `${keyPrefix}-${i}-${li++}`));
      segs.push(
        <a key={`${keyPrefix}-${i}-lk${li++}`} href={m[2]} target="_blank" rel="noreferrer" className="md-link">
          {m[1]}
        </a>
      );
      last = m.index + m[0].length;
    }
    if (last < part.length) segs.push(...renderEmphasis(part.slice(last), `${keyPrefix}-${i}-${li++}`));
    nodes.push(...segs);
  });
  return nodes;
}

// GFM 表格行拆分：去掉首尾竖线并按 | 分列（与 markdownHtml.splitRow 完全一致）
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export interface AiSectionImage {
  dataUrl: string;
  caption?: string;
}

export function AiMarkdown({
  source,
  sectionImages,
}: {
  source: string;
  /**
   * 图文报告内嵌图：遇 `<!--SNAP:k-->` 标记时，把第 k 张图渲染为 `<figure>`。
   * 容忍空格的正则与导出路径（markdownHtml / markdownDocx / markdownPptx）保持一致，
   * 避免应用内看到 `<!-- SNAP:1 -->` 原始注释。
   */
  sectionImages?: AiSectionImage[];
}) {
  // SNAP 标记正则（容忍空格），与 aiPresets.SNAP_MARKER_RE / markdownHtml / markdownDocx / markdownPptx 对齐
  const SNAP_LINE_RE = /^<!--\s*SNAP:(\d+)\s*-->$/;
  // 聊天/历史展示时把 SNAP 标记替换为内嵌图（导出时才真正剥离），核心卖点
  // 「截图 → 图文报告」在 app 内也能直接看到图文混排，与导出（mdToHtml / docx / pptx）一致。
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // SNAP 章节锚点：渲染为对应截图（核心卖点：app 内即看图文混排）
    const snapMatch = SNAP_LINE_RE.exec(trimmed);
    if (snapMatch) {
      const idx = parseInt(snapMatch[1], 10) - 1; // 1 基标记 → 0 基数组
      const img = sectionImages?.[idx];
      if (img?.dataUrl) {
        blocks.push(
          <figure key={key++} className="md-snap">
            <img src={img.dataUrl} alt={img.caption ?? ''} className="md-snap-img" />
            {img.caption ? <figcaption className="md-snap-cap">{img.caption}</figcaption> : null}
          </figure>,
        );
      } else if (sectionImages) {
        // 调用方传了 sectionImages 但第 k 张不存在（k 越界）：降级为占位，避免裸标记泄露
        blocks.push(
          <div key={key++} className="md-snap-missing">
            [图片 {snapMatch[1]} 缺失]
          </div>,
        );
      }
      // 未传 sectionImages 时静默跳过（保持原"仅过滤标记"行为，避免破坏非图文报告场景）
      i++;
      continue;
    }

    if (!trimmed) {
      i++;
      continue;
    }

    // 代码块
    if (trimmed.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key++} className="md-pre">
          <code>{buf.join('\n')}</code>
        </pre>
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // 标题（H1-H6 全级别支持：bug / insight 等预设常用 5-6 级嵌套小节）
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = renderInline(h[2], `h${key}`);
      if (level === 1) blocks.push(<h1 key={key++} className="md-h1">{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={key++} className="md-h2">{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={key++} className="md-h3">{content}</h3>);
      else if (level === 4) blocks.push(<h4 key={key++} className="md-h4">{content}</h4>);
      else if (level === 5) blocks.push(<h5 key={key++} className="md-h5">{content}</h5>);
      else blocks.push(<h6 key={key++} className="md-h6">{content}</h6>);
      i++;
      continue;
    }

    // 分割线
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderInline(buf.join(' '), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="md-ol">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 无序列表（含 GFM 任务清单 - [ ] / - [x]：PRD 验收清单、bug/meeting 行动项等）
    if (/^[-*+]\s+/.test(line)) {
      const items: { text: string; task?: boolean; checked?: boolean }[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const m = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push({ text: m[2], task: true, checked: m[1].toLowerCase() === 'x' });
        } else {
          items.push({ text: lines[i].replace(/^[-*+]\s+/, ''), task: false });
        }
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items.map((it, idx) => (
            <li key={idx} className={it.task ? 'md-task' : undefined}>
              {it.task ? (
                <input type="checkbox" readOnly checked={!!it.checked} className="md-task-cb" />
              ) : null}
              {renderInline(it.text, `ul${key}-${idx}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 表格（GFM）：当前行含 | 且下一行是分隔行（仅含 | : - 与空白）。
    // 解析规则与导出器 markdownHtml 严格一致，避免"预览看不到表格、导出的 docx/html 却有"的偏差
    // （doc / bug / prd / compete / meeting / insight / table 等预设都常产出表格）。
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])
    ) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        const l = t.startsWith(':');
        const r = t.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const bodyRows: ReactNode[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        const ri = bodyRows.length;
        bodyRows.push(
          <tr key={ri}>
            {cells.map((c, idx) => (
              <td
                key={idx}
                style={aligns[idx] ? ({ textAlign: aligns[idx] } as CSSProperties) : undefined}
              >
                {renderInline(c, `tb-${key}-${ri}-${idx}`)}
              </td>
            ))}
          </tr>,
        );
        i++;
      }
      blocks.push(
        <table key={key++} className="md-table">
          <thead>
            <tr>
              {head.map((c, idx) => (
                <th
                  key={idx}
                  style={aligns[idx] ? ({ textAlign: aligns[idx] } as CSSProperties) : undefined}
                >
                  {renderInline(c, `th-${key}-${idx}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{bodyRows}</tbody>
        </table>,
      );
      continue;
    }

    // 段落（合并连续普通行）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|>|\d+\.\s|[-*]\s|---+$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(buf.join(' '), `p${key}`)}
      </p>
    );
  }

  return <div className="ai-markdown">{blocks}</div>;
}
