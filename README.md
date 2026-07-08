# SnapCraft

A premium cross-platform screenshot tool built with Tauri 2, React, and Konva.js.

## ✨ Features

- **Multiple Capture Modes**: Full screen, region, window, and scrolling capture
- **Annotation Tools**: Arrow, text, mosaic, crop, and more
- **OCR Recognition**: Extract text from screenshots with Tesseract.js
- **Screenshot History**: Manage and search your screenshot history
- **Keyboard Shortcuts**: Global shortcuts for quick capture
- **Cross-Platform**: Runs on macOS, Windows, and Linux
- **Premium Experience**: Smooth animations, glass morphism, and premium UI design

## 🎯 Core Features

### Screenshot Modes
- **Full Screen**: Capture the entire screen
- **Region**: Select a custom region to capture
- **Window**: Capture a specific window
- **Scrolling**: Capture long scrolling content

### Annotation Tools
- **Arrow**: Draw arrows to point out important areas
- **Text**: Add text annotations
- **Mosaic**: Blur sensitive information
- **Crop**: Crop the screenshot
- **Shape**: Draw rectangles, circles, and other shapes

### Additional Features
- **OCR**: Recognize text from screenshots
- **Copy to Clipboard**: Quick copy to clipboard
- **Save Locally**: Save to custom path
- **History Management**: Search and manage screenshot history
- **Keyboard Shortcuts**: Customizable global shortcuts

## 🛠️ Tech Stack

### Frontend
- React 18 + TypeScript
- Vite 6
- Konva.js (Canvas editing)
- Zustand (state management)
- MUI (UI components)

### Backend
- Tauri 2 (Rust)
- Global shortcuts plugin
- File system plugin
- Clipboard plugin

## 📦 Installation

### Prerequisites

- Node.js 20+
- pnpm 8+
- Rust stable
- Tauri 2 prerequisites (see [Tauri docs](https://tauri.app/v2/guides/getting-started/prerequisites))

### Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm tauri dev

# Build for production
pnpm tauri build
```

### Build for Specific Platform

```bash
# macOS
pnpm tauri build

# Windows
pnpm tauri build

# Linux
pnpm tauri build
```

## 📝 Usage

1. **Launch SnapCraft**
2. **Use keyboard shortcut** (default: `Cmd/Ctrl + Shift + S`) to start capture
3. **Select capture mode** from the toolbar
4. **Annotate** your screenshot with the annotation tools
5. **Save or copy** your screenshot

## ⌨️ Default Keyboard Shortcuts

- **Capture**: `Cmd/Ctrl + Shift + S`
- **Full Screen**: `Cmd/Ctrl + Shift + 1`
- **Region**: `Cmd/Ctrl + Shift + 2`
- **Window**: `Cmd/Ctrl + Shift + 3`
- **Save**: `Cmd/Ctrl + S`
- **Copy**: `Cmd/Ctrl + C`

## 🎨 UI Design

SnapCraft features a premium UI design with:
- **Glass morphism effects**
- **Smooth animations** (60fps)
- **Dark/Light/System theme toggle**
- **Magnetic hover effects**
- **Responsive design**

## 🚀 Roadmap

- [ ] Advanced annotation tools (pen, highlighter)
- [ ] Cloud sync for screenshot history
- [ ] Video recording
- [ ] GIF creation
- [ ] AI-powered features (auto-blur, smart crop)

## 📄 License

Apache License 2.0

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

**Craft Your Screenshots with Precision** ✨
