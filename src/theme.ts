import { normalizePath, TAbstractFile } from "obsidian";
import type MermaidToolkitPlugin from "./main";

const THEME_STYLE_ID = "mermaid-toolkit-theme";
const DGUV_PATH = "_ADMIN/styles/style-dguv.css";
const UVITAS_PATH = "_ADMIN/styles/style-uvitas.css";

// Loads a Mermaid style CSS file from the vault and injects it as a <style>.
// Watches the resolved file for live-reload while editing. The concrete files
// (style-dguv.css / style-uvitas.css) are created in Phase 3 - a missing file
// only warns and injects nothing.
export class ThemeManager {
	private readonly plugin: MermaidToolkitPlugin;
	private styleEl?: HTMLStyleElement;

	constructor(plugin: MermaidToolkitPlugin) {
		this.plugin = plugin;
	}

	// Register a single vault watcher; re-applies when the active theme file is
	// edited (live reload).
	setupWatch() {
		this.plugin.registerEvent(
			this.plugin.app.vault.on("modify", (file: TAbstractFile) => {
				const active = this.resolvePath();
				if (active && file.path === active) {
					void this.apply();
				}
			}),
		);
	}

	// Vault-relative path of the currently selected theme, or null when off.
	private resolvePath(): string | null {
		const s = this.plugin.settings;
		switch (s.themeMode) {
			case "dguv":
				return normalizePath(DGUV_PATH);
			case "uvitas":
				return normalizePath(UVITAS_PATH);
			case "custom":
				return s.customThemePath ? normalizePath(s.customThemePath) : null;
			default:
				return null;
		}
	}

	async apply() {
		const path = this.resolvePath();
		if (!path) {
			this.remove();
			return;
		}

		const adapter = this.plugin.app.vault.adapter;
		let css: string;
		try {
			if (!(await adapter.exists(path))) {
				console.warn(`Mermaid Toolkit: Theme-Datei fehlt: ${path}`);
				this.remove();
				return;
			}
			css = await adapter.read(path);
		} catch (e) {
			console.warn(`Mermaid Toolkit: Theme-Datei nicht lesbar: ${path}`, e);
			this.remove();
			return;
		}

		if (!this.styleEl) {
			this.styleEl = document.createElement("style");
			this.styleEl.id = THEME_STYLE_ID;
			document.head.appendChild(this.styleEl);
		}
		this.styleEl.textContent = css;
	}

	remove() {
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = undefined;
		}
	}
}
