# Mermaid Toolkit

An Obsidian plugin bundling everything for Mermaid diagrams: responsive zoom &
pan, icons inside node labels, and a vault-driven theme loader.

> As of v2.0.0 this plugin also absorbs
> [obsidian-mermaid-icons](https://github.com/ALXRITR/obsidian-mermaid-icons)
> and gains a theme loader. The manifest `id` stays `obsidian-mermaid-zoom` so
> the plugin folder, BRAT registration and existing settings keep working.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

### Zoom & pan
- **Mouse Wheel Zoom** - Scroll (with Ctrl/Cmd by default) over any Mermaid diagram to zoom
- **Drag to Pan** - Click and drag to move around your diagrams
- **Touch Gestures** - Pinch to zoom and drag to pan on mobile devices
- **Control Buttons** - Zoom in, zoom out, reset, fullscreen
- **Scale Indicator** - Real-time display of current zoom level
- **Fullscreen Mode** - Open diagrams in a modal for better viewing

### Icons (merged from mermaid-icons)
- **Label icons** - `logos:*`, `lucide:*`, `clarity:*`, custom SVG packs and
  Font Awesome (`fa:*`) rendered inside node/edge labels
- **Custom packs** - drop SVGs into a configurable vault folder
  (default `_ADMIN/mermaid-icon-packs`), one pack per subfolder
- **Insert-icon command** + inline `<code>` preview in the editor
- **Configurable icon colour** via `--mermaid-label-icon-color`

### Theme loader
- Load a Mermaid style CSS straight from the vault
  (`DGUV` / `uvitas` / custom path), injected for on-screen diagrams
- Live-reloads when the style file is edited

## Architecture

```
src/main.ts       Plugin bootstrap, settings load/save, CSS injection
src/pipeline.ts   Single MutationObserver: icons -> measure -> wrap (deterministic)
src/zoom.ts       Zoom/pan engine, fullscreen modal, resize handle
src/icons.ts      Icon packs, label-token replacement, custom-pack loader
src/theme.ts      Vault-driven theme CSS loader with live reload
src/settings.ts   Settings tab + defaults
```

## Installation

### Obsidian Plugin Market (Coming Soon)

Once approved, install directly from Obsidian's community plugins browser.

### Manual Installation

1. Download the latest release from [GitHub Releases](https://github.com/xiaozhuang0433/mermaid-zoom/releases)
2. Extract to your vault's plugins directory:
   ```
   <your-vault>/.obsidian/plugins/mermaid-zoom
   ```
3. Enable the plugin in Obsidian:
   - Settings → Community Plugins
   - Find "Mermaid Zoom" and enable it

## Usage

### Mouse Controls

| Action | Description |
|--------|-------------|
| **Zoom** | Hover over a Mermaid diagram and scroll the mouse wheel |
| **Pan** | Click and drag to move the diagram |
| **Fullscreen** | Click the fullscreen button to open in modal view |

### Touch Controls (Mobile)

| Action | Description |
|--------|-------------|
| **Zoom** | Pinch with two fingers |
| **Pan** | Drag with one finger |

### Control Buttons

Located in the bottom-right corner of each diagram:

- **`+`** - Zoom in
- **`-`** - Zoom out
- **`⟲`** - Reset to fit
- **`⛶`** - Toggle fullscreen

## Development

```bash
# Install dependencies
npm install

# Development mode (watch for changes)
npm run dev

# Production build
npm run build
```

## How It Works

The plugin automatically detects all Mermaid diagrams rendered in Obsidian and wraps each one in a zoomable container. Zoom range is configurable from 10% to 500%.

Original SVG dimensions are cached to ensure consistent scaling behavior when resetting or resizing.

## License

[MIT](LICENSE) © [Wang Xiao Zhuang](https://github.com/xiaozhuang0433)

## Support

- Issues: [GitHub Issues](https://github.com/xiaozhuang0433/mermaid-zoom/issues)
- Discussions: [GitHub Discussions](https://github.com/xiaozhuang0433/mermaid-zoom/discussions)
