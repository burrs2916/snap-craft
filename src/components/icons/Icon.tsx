import React from "react";
import * as LucideIcons from "lucide-react";
import * as PhosphorIcons from "@phosphor-icons/react";
import { TwemojiIcon } from "./TwemojiIcon";

export type IconLibrary = "lucide" | "phosphor" | "twemoji";

export interface IconProps {
  name: string;
  library?: IconLibrary;
  size?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
  weight?: "thin" | "light" | "regular" | "medium" | "bold" | "fill" | "duotone";
}

const lucideIconMap: Record<string, string> = {
  dashboard: "LayoutDashboard",
  scene: "Layers",
  map: "Map",
  datasource: "Database",
  chart: "BarChart3",
  table: "Table2",
  metric: "Gauge",
  alert: "AlertTriangle",
  log: "FileText",
  history: "History",
  settings: "Settings",
  info: "Info",
  help: "HelpCircle",
  search: "Search",
  notification: "Bell",
  fullscreen: "Maximize",
  user: "User",
  menu: "Menu",
  chevronLeft: "ChevronLeft",
  chevronRight: "ChevronRight",
  add: "Plus",
  edit: "Edit3",
  delete: "Trash2",
  save: "Save",
  cancel: "X",
  check: "Check",
  refresh: "RefreshCw",
  download: "Download",
  upload: "Upload",
  export: "Download",
  import: "Upload",
  filter: "Filter",
  sort: "ArrowUpDown",
  expand: "ChevronDown",
  collapse: "ChevronUp",
  home: "Home",
  folder: "Folder",
  file: "File",
  image: "Image",
  video: "Video",
  audio: "Music",
  link: "Link",
  external: "ExternalLink",
  copy: "Copy",
  paste: "Clipboard",
  cut: "Scissors",
  undo: "Undo",
  redo: "Redo",
  zoomIn: "ZoomIn",
  zoomOut: "ZoomOut",
  maximize: "Maximize2",
  minimize: "Minimize2",
  close: "X",
  more: "MoreVertical",
  moreHorizontal: "MoreHorizontal",
  star: "Star",
  heart: "Heart",
  bookmark: "Bookmark",
  tag: "Tag",
  calendar: "Calendar",
  clock: "Clock",
  location: "MapPin",
  globe: "Globe",
  mail: "Mail",
  phone: "Phone",
  lock: "Lock",
  unlock: "Unlock",
  eye: "Eye",
  eyeOff: "EyeOff",
  sun: "Sun",
  moon: "Moon",
  cloud: "Cloud",
  weather: "CloudSun",
  thermometer: "Thermometer",
  droplet: "Droplet",
  wind: "Wind",
  fire: "Flame",
  zap: "Zap",
  shield: "Shield",
  award: "Award",
  trophy: "Trophy",
  target: "Target",
  flag: "Flag",
  bell: "Bell",
  bellOff: "BellOff",
  volume: "Volume2",
  volumeOff: "VolumeX",
  play: "Play",
  pause: "Pause",
  stop: "Square",
  skipBack: "SkipBack",
  skipForward: "SkipForward",
  repeat: "Repeat",
  shuffle: "Shuffle",
};

const phosphorIconMap: Record<string, string> = {
  dashboard: "SquaresFour",
  scene: "Stack",
  map: "MapTrifold",
  datasource: "Database",
  chart: "ChartBar",
  table: "Table",
  metric: "Speedometer",
  alert: "Warning",
  log: "Article",
  history: "ClockCounterClockwise",
  settings: "GearSix",
  info: "Info",
  help: "Question",
  search: "MagnifyingGlass",
  notification: "Bell",
  fullscreen: "ArrowsOut",
  user: "User",
  menu: "List",
  chevronLeft: "CaretLeft",
  chevronRight: "CaretRight",
  add: "Plus",
  edit: "PencilSimple",
  delete: "Trash",
  save: "FloppyDisk",
  cancel: "X",
  check: "Check",
  refresh: "ArrowClockwise",
  download: "DownloadSimple",
  upload: "UploadSimple",
  export: "Export",
  import: "Import",
  filter: "Funnel",
  sort: "ArrowsDownUp",
  expand: "CaretDown",
  collapse: "CaretUp",
  home: "House",
  folder: "Folder",
  file: "File",
  image: "Image",
  video: "VideoCamera",
  audio: "SpeakerHigh",
  link: "Link",
  external: "ArrowSquareOut",
  copy: "Copy",
  paste: "ClipboardText",
  cut: "Scissors",
  undo: "ArrowUUpLeft",
  redo: "ArrowUUpRight",
  zoomIn: "MagnifyingGlassPlus",
  zoomOut: "MagnifyingGlassMinus",
  maximize: "ArrowsOut",
  minimize: "ArrowsIn",
  close: "X",
  more: "DotsThreeVertical",
  moreHorizontal: "DotsThree",
  star: "Star",
  heart: "Heart",
  bookmark: "BookmarkSimple",
  tag: "Tag",
  calendar: "Calendar",
  clock: "Clock",
  location: "MapPin",
  globe: "Globe",
  mail: "Envelope",
  phone: "Phone",
  lock: "Lock",
  unlock: "LockOpen",
  eye: "Eye",
  eyeOff: "EyeSlash",
  sun: "Sun",
  moon: "Moon",
  cloud: "Cloud",
  weather: "CloudSun",
  thermometer: "Thermometer",
  droplet: "Drop",
  wind: "Wind",
  fire: "Fire",
  zap: "Lightning",
  shield: "ShieldCheck",
  award: "Medal",
  trophy: "Trophy",
  target: "Crosshair",
  flag: "Flag",
  bell: "Bell",
  bellOff: "BellSlash",
  volume: "SpeakerHigh",
  volumeOff: "SpeakerX",
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  skipBack: "SkipBack",
  skipForward: "SkipForward",
  repeat: "Repeat",
  shuffle: "Shuffle",
};

const twemojiIconMap: Record<string, string> = {
  dashboard: "📊",
  scene: "📑",
  map: "🗺️",
  datasource: "💾",
  chart: "📈",
  table: "📋",
  metric: "⚡",
  alert: "⚠️",
  log: "📝",
  history: "📜",
  settings: "⚙️",
  info: "ℹ️",
  help: "❓",
  search: "🔍",
  notification: "🔔",
  fullscreen: "⛶",
  user: "👤",
  menu: "☰",
  chevronLeft: "◀",
  chevronRight: "▶",
  add: "➕",
  edit: "✏️",
  delete: "🗑️",
  save: "💾",
  cancel: "❌",
  check: "✅",
  refresh: "🔄",
  download: "⬇️",
  upload: "⬆️",
  export: "📤",
  import: "📥",
  filter: "🔽",
  sort: "↕️",
  expand: "🔽",
  collapse: "🔼",
  home: "🏠",
  folder: "📁",
  file: "📄",
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  link: "🔗",
  external: "🔗",
  copy: "📋",
  paste: "📋",
  cut: "✂️",
  undo: "↩️",
  redo: "↪️",
  zoomIn: "🔍",
  zoomOut: "🔍",
  maximize: "⬜",
  minimize: "🔲",
  close: "✕",
  more: "⋮",
  moreHorizontal: "⋯",
  star: "⭐",
  heart: "❤️",
  bookmark: "🔖",
  tag: "🏷️",
  calendar: "📅",
  clock: "🕐",
  location: "📍",
  globe: "🌐",
  mail: "📧",
  phone: "📞",
  lock: "🔒",
  unlock: "🔓",
  eye: "👁️",
  eyeOff: "👁️‍🗨️",
  sun: "☀️",
  moon: "🌙",
  cloud: "☁️",
  weather: "🌤️",
  thermometer: "🌡️",
  droplet: "💧",
  wind: "💨",
  fire: "🔥",
  zap: "⚡",
  shield: "🛡️",
  award: "🏅",
  trophy: "🏆",
  target: "🎯",
  flag: "🚩",
  bell: "🔔",
  bellOff: "🔕",
  volume: "🔊",
  volumeOff: "🔇",
  play: "▶️",
  pause: "⏸️",
  stop: "⏹️",
  skipBack: "⏮️",
  skipForward: "⏭️",
  repeat: "🔁",
  shuffle: "🔀",
};

export function Icon({
  name,
  library = "lucide",
  size = 24,
  color,
  className,
  style,
  weight = "regular",
}: IconProps) {
  if (library === "twemoji") {
    const emoji = twemojiIconMap[name] || name;
    return (
      <TwemojiIcon
        emoji={emoji}
        size={size}
        className={className}
        style={style}
      />
    );
  }

  if (library === "phosphor") {
    const iconName = phosphorIconMap[name] || name;
    const PhosphorIcon = (PhosphorIcons as unknown as Record<string, React.ComponentType<any>>)[iconName];
    
    if (!PhosphorIcon) {
      console.warn(`Phosphor icon "${iconName}" not found`);
      return null;
    }
    
    return (
      <PhosphorIcon
        size={size}
        color={color}
        className={className}
        style={style}
        weight={weight}
      />
    );
  }

  const iconName = lucideIconMap[name] || name;
  const LucideIcon = (LucideIcons as unknown as Record<string, React.ComponentType<any>>)[iconName];
  
  if (!LucideIcon) {
    console.warn(`Lucide icon "${iconName}" not found`);
    return null;
  }
  
  return (
    <LucideIcon
      size={size}
      color={color}
      className={className}
      style={style}
    />
  );
}

export default Icon;
