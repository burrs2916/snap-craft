import React, { useMemo } from "react";
import twemoji from "twemoji";

interface TwemojiIconProps {
  emoji: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function TwemojiIcon({ emoji, size = 24, className, style }: TwemojiIconProps) {
  const svg = useMemo(() => {
    const parsed = twemoji.parse(emoji, {
      folder: "svg",
      ext: ".svg",
    });
    
    const match = parsed.match(/src="([^"]+)"/);
    return match ? match[1] : null;
  }, [emoji]);

  if (!svg) {
    return <span style={{ fontSize: size, ...style }}>{emoji}</span>;
  }

  return (
    <img
      src={svg}
      alt={emoji}
      className={className}
      style={{
        width: size,
        height: size,
        display: "inline-block",
        verticalAlign: "middle",
        ...style,
      }}
    />
  );
}

export default TwemojiIcon;
