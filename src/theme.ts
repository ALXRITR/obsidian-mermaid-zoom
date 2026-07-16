import { loadMermaid, normalizePath, TAbstractFile } from "obsidian";
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
		void this.syncMermaidConfig();
	}

	// Mermaid measures node/edge labels with ITS OWN configured font while our
	// theme CSS overrides the rendered font - long labels then overflow their
	// boxes. Align mermaid's measurement font with the theme (future renders;
	// existing diagrams re-render on view switch).
	//
	// MERGE-SAFE: mermaid.initialize() REPLACES the site config and wiped
	// Obsidian's own settings (useMaxWidth etc.), breaking diagram fitting.
	// mermaidAPI.updateSiteConfig() deep-merges into the existing site config
	// instead (verified against the bundled Mermaid via CDP: getSiteConfig /
	// updateSiteConfig exist and flowchart.subGraphTitleMargin is supported).
	// Only fontFamily, fontSize and the subgraph title margins are touched.
	private savedMermaidConfig?: Record<string, unknown>;

	private async syncMermaidConfig() {
		try {
			const mermaid = (await loadMermaid()) as {
				mermaidAPI?: {
					getSiteConfig(): Record<string, unknown>;
					updateSiteConfig(
						conf: Record<string, unknown>,
					): Record<string, unknown>;
				};
			};
			const api = mermaid.mermaidAPI;
			if (!api?.getSiteConfig || !api?.updateSiteConfig) return; // no merge-safe path: leave Obsidian's config alone

			// Snapshot the pre-override values once so remove() can restore them.
			if (!this.savedMermaidConfig) {
				const site = api.getSiteConfig();
				const flowchart = (site.flowchart ?? {}) as Record<string, unknown>;
				this.savedMermaidConfig = {
					fontFamily: site.fontFamily,
					fontSize: site.fontSize,
					flowchart: {
						subGraphTitleMargin: flowchart.subGraphTitleMargin ?? {
							top: 0,
							bottom: 0,
						},
					},
				};
			}

			const family =
				getComputedStyle(document.body)
					.getPropertyValue("--uvi-font-body")
					.trim() || '"Source Sans 3", "Segoe UI", sans-serif';
			api.updateSiteConfig({
				fontFamily: family,
				fontSize: 14,
				// Air for subgraph titles: off the top border and clear of the
				// first child nodes (default is {top:0,bottom:0}).
				flowchart: { subGraphTitleMargin: { top: 6, bottom: 10 } },
			});
		} catch {
			/* best-effort */
		}
	}

	// Put Obsidian's own values back (theme switched off / file missing).
	private async restoreMermaidConfig() {
		if (!this.savedMermaidConfig) return;
		try {
			const mermaid = (await loadMermaid()) as {
				mermaidAPI?: {
					updateSiteConfig(
						conf: Record<string, unknown>,
					): Record<string, unknown>;
				};
			};
			mermaid.mermaidAPI?.updateSiteConfig(this.savedMermaidConfig);
			this.savedMermaidConfig = undefined;
		} catch {
			/* best-effort */
		}
	}

	remove() {
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = undefined;
		}
		void this.restoreMermaidConfig();
	}
}
