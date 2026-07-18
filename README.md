# SnapCraft

A premium cross-platform screenshot tool built with **Tauri 2 + React 18 + Konva.js**, with system-native capture and OCR. macOS is the primary target (Windows / Linux supported).

## ✨ Features

- **Multiple Capture Modes**: Full screen (multi-display picker), region, window, and scrolling long-capture
- **Rich Annotation**: 10 tools — select, arrow, line, rectangle, ellipse, text, pen, highlighter, mosaic, numbered step
- **System-Native OCR**: Extract text using the OS engine — Apple Vision on macOS, WinRT `Windows.Media.Ocr` on Windows. Zero JS/OCR runtime dependency.
- **Screenshot History**: Add / view / delete / clear your capture history
- **Pin to Screen**: Pin any capture as a floating always-on-top window
- **Global Shortcuts**: System-wide hotkeys for instant capture
- **Cross-Platform**: macOS, Windows, and Linux
- **Theme**: Light / Dark / Follow-system, with no-flash (FOUC-free) initial paint

## 🎯 Core Features

### Capture Modes
- **Full Screen**: Capture an entire display; on multi-monitor setups an in-app centered picker appears
- **Region**: Interactive crosshair selection
- **Window**: Click a target window to capture it
- **Scrolling**: Capture long scrolling content with automatic frame stitching

> On macOS, capture uses the system-native `screencapture` (`-x` full / `-i` region / `-w` window) — no custom transparent overlay, which proved unreliable across multi-display + negative-coordinate layouts. Windows / Linux use `xcap` with dedicated region/window overlays.

### Annotation Tools
Select · Arrow · Line · Rectangle · Ellipse · Text · Pen · Highlighter · Mosaic · Numbered step.
Styling: 6-color palette, 4 stroke widths, text size / bold / background plate, and privacy masking (mosaic or Gaussian blur with adjustable strength). Full undo / redo (snapshot stack, up to 50 steps).

### Export & More
- **Copy to Clipboard**
- **Save Locally** (path picker)
- **Pin Window** — floating, borderless, always-on-top, draggable, proportional resize
- **OCR** — one-click text recognition via the OS-native engine
- **History Management**

## 🛠️ Tech Stack

### Frontend
- React 18 + TypeScript
- Vite 6 (build split into `index` / `vendor-react` / `vendor-konva` chunks)
- Konva.js + react-konva (annotation canvas)
- Zustand (state management + undo/redo)
- Hand-written CSS (no UI framework)

### Backend (Rust · Tauri 2)
- `tauri-plugin-global-shortcut` — global hotkeys
- `tauri-plugin-dialog` — native file dialogs
- `xcap` — cross-platform capture (Windows / Linux)
- `apple-vision` — macOS OCR (compile-time bound; zero user setup)
- Windows OCR via system PowerShell 5.1 → WinRT `Windows.Media.Ocr` (no `windows` crate)

## 📦 Installation

### Prerequisites
- Node.js 20+
- pnpm 8+
- Rust stable
- Tauri 2 prerequisites (see [Tauri docs](https://tauri.app/start/prerequisites/))

### Development

> **macOS note**: run via `./start.sh dev`, **not** `pnpm tauri dev`. The dev binary is bundled into a real `.app` and code-signed with a local certificate so it registers in the macOS TCC "Screen Recording" list and **retains permission across rebuilds** (an ad-hoc-signed bare binary loses permission on every recompile).

```bash
# Install dependencies
pnpm install

# macOS — recommended dev flow (bundles + signs a dev .app)
./start.sh dev

# One-time: create a local signing certificate (no Apple Developer account needed)
./start.sh cert
# then: export SNAP_SIGN_ID="SnapCraft Local"

# Frontend-only dev server (no Tauri shell)
pnpm dev

# Production build
pnpm build          # tsc && vite build (frontend)
pnpm app            # bundle the app via start.sh
pnpm build:local    # scripts/build-local.sh
```

### Backing up your dev signing identity

Your local self-signed certificate (default name `SnapCraft Local`) is what gives the dev build a stable **public-key identity**, so the macOS "Screen Recording" TCC permission survives recompilation. **If you lose it (system upgrade, Time Machine restore, new machine) you have to re-authorize TCC.**

```bash
# One-time: back up the certificate + private key to ~/.snapcraft/keys/
./start.sh backup-cert

# Later (on a new machine, or after restoring from backup):
./start.sh restore-cert ~/.snapcraft/keys/SnapCraft\ Local-20260718-103045.p12
# then in Keychain Access: 双击证书 → Trust → Code Signing: Always Trust
# then: export SNAP_SIGN_ID="SnapCraft Local"
```

The backup is a `.p12` file containing both the cert and the private key — store it somewhere safe (encrypted disk / 1Password). The trust setting does **not** survive export, so after restore you must re-check "Always Trust" in Keychain Access (one GUI step).

## 📝 Usage

1. **Launch SnapCraft** (grant Screen Recording permission on first run — a system prompt appears before the window hides)
2. **Press a global shortcut** to start capture
3. **Pick a mode** or use the mode-specific shortcut
4. **Annotate** with the toolbar tools
5. **Save / Copy / Pin / OCR** the result

## ⌨️ Default Global Shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Capture (default mode) | ⌘⇧S | Ctrl+Shift+S |
| Full Screen | ⌘⇧1 | Ctrl+Shift+1 |
| Region | ⌘⇧2 | Ctrl+Shift+2 |
| Window | ⌘⇧3 | Ctrl+Shift+3 |
| Scrolling | ⌘⇧4 | Ctrl+Shift+4 |
| Quit | ⌘Q | Ctrl+Q |

## 🎨 UI Design

- **Light / Dark / Follow-system** theme with no-flash initial paint
- Smooth animations and refined micro-interactions
- System-tray resident with quick actions

## 🚀 Roadmap

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
