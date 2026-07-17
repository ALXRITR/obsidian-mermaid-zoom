import {
	App,
	loadMermaid,
	FuzzySuggestModal,
	FuzzyMatch,
	normalizePath,
	Notice,
} from "obsidian";
import { icons as logos } from "@iconify-json/logos";
import { icons as lucide } from "@iconify-json/lucide";
import { icons as clarity } from "@iconify-json/clarity";
import type { MermaidToolkitSettings } from "./settings";

export interface IconifyIcon {
	body: string;
	width?: number;
	height?: number;
	left?: number;
	top?: number;
}

export interface IconifyJSON {
	prefix: string;
	icons: Record<string, IconifyIcon>;
	width?: number;
	height?: number;
}

interface Mermaid {
	registerIconPacks: (packs: { name: string; icons: unknown }[]) => void;
}

const BundledPacks: Array<{ name: string; icons: IconifyJSON }> = [
	{ name: logos.prefix, icons: logos as unknown as IconifyJSON },
	{ name: lucide.prefix, icons: lucide as unknown as IconifyJSON },
	{ name: clarity.prefix, icons: clarity as unknown as IconifyJSON },
];

export function setSvg(el: HTMLElement, svgString: string) {
	const parser = new DOMParser();
	const doc = parser.parseFromString(svgString, "image/svg+xml");
	if (doc.documentElement && !doc.querySelector("parsererror")) {
		el.empty();
		el.appendChild(doc.documentElement);
	}
}

// Ports the icon logic of obsidian-mermaid-icons: it registers bundled +
// custom SVG packs with Mermaid and replaces `<prefix>:<name>` tokens inside
// rendered diagram labels with isolated data-URI <img> icons.
export class IconManager {
	private readonly app: App;
	private readonly getSettings: () => MermaidToolkitSettings;
	private customPacks: Array<{ name: string; icons: IconifyJSON }> = [];

	constructor(app: App, getSettings: () => MermaidToolkitSettings) {
		this.app = app;
		this.getSettings = getSettings;
	}

	// Bundled packs + user-supplied custom packs.
	allPacks(): Array<{ name: string; icons: IconifyJSON }> {
		return [...BundledPacks, ...this.customPacks];
	}

	// Register bundled + custom packs with Mermaid (best-effort). Loading the
	// full Mermaid library is deferred out of onload by the caller.
	async registerWithMermaid() {
		try {
			const mermaid = (await loadMermaid()) as Mermaid;
			mermaid.registerIconPacks(
				this.allPacks().map((p) => ({ name: p.name, icons: p.icons })),
			);
		} catch {
			/* registration is best-effort */
		}
	}

	// --- Custom icon pack loading ---

	// Scan the configured vault folder; every direct subfolder becomes a pack
	// named after the folder, with one icon per `.svg` file.
	async loadCustomPacks(folder: string = this.getSettings().iconPackFolder) {
		this.customPacks = [];
		// Read straight from the filesystem via the adapter - Obsidian's
		// getFiles() index does not expose externally-created .svg files
		// reliably. NFC-normalise names for umlaut-safe comparisons.
		const adapter = this.app.vault.adapter;
		const base = normalizePath(folder);
		const packs: Record<string, Record<string, IconifyIcon>> = {};
		let totalSvg = 0;

		try {
			if (await adapter.exists(base)) {
				const root = await adapter.list(base);
				for (const packPath of root.folders) {
					const packName = (packPath.split("/").pop() || "").normalize("NFC");
					if (!packName) continue;
					const listed = await adapter.list(packPath);
					for (const fp of listed.files) {
						if (!fp.toLowerCase().endsWith(".svg")) continue;
						totalSvg++;
						const iconName = (fp.split("/").pop() || "")
							.replace(/\.svg$/i, "")
							.normalize("NFC");
						if (!iconName) continue;
						try {
							const svgText = await adapter.read(fp);
							const icon = this.svgToIcon(svgText, `${packName}-${iconName}`);
							if (icon) (packs[packName] ??= {})[iconName] = icon;
						} catch {
							// skip invalid svg
						}
					}
				}
			}
		} catch (e) {
			console.error("Mermaid Toolkit: loadCustomPacks failed", e);
		}

		for (const [name, icons] of Object.entries(packs)) {
			if (Object.keys(icons).length > 0) {
				this.customPacks.push({ name, icons: { prefix: name, icons } });
			}
		}

		if (totalSvg > 0 || this.customPacks.length > 0) {
			const summary =
				this.customPacks
					.map((p) => `${p.name}(${Object.keys(p.icons.icons).length})`)
					.join(", ") || "NONE";
			new Notice(
				`Mermaid Toolkit: ${totalSvg} Pack-SVGs, geladen: ${summary}`,
				6000,
			);
		}
	}

	// Convert a raw SVG string into an iconify-style icon entry, namespacing any
	// internal ids and (for single-colour icons) switching to `currentColor`.
	private svgToIcon(svgText: string, scope: string): IconifyIcon | null {
		const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
		const svg = doc.querySelector("svg");
		if (!svg || doc.querySelector("parsererror")) return null;

		let left = 0;
		let top = 0;
		let width = 0;
		let height = 0;
		const vb = svg.getAttribute("viewBox");
		if (vb) {
			const p = vb.split(/[\s,]+/).map(Number);
			if (p.length === 4 && p.every((n) => !Number.isNaN(n))) {
				[left, top, width, height] = p;
			}
		}
		if (!width) width = parseFloat(svg.getAttribute("width") || "") || 24;
		if (!height) height = parseFloat(svg.getAttribute("height") || "") || 24;

		let body = "";
		const serializer = new XMLSerializer();
		svg.childNodes.forEach((c) => {
			body += serializer.serializeToString(c);
		});

		// Single-colour icons -> currentColor, so the colour baked into the <img>
		// wrapper (navy on default boxes, white on primary) applies to them too.
		// Multi-colour icons (pictograms/logos) keep their own colours. Ids are
		// namespaced for icon-shape usage where the body is inlined into the svg.
		body = this.namespaceIds(body, scope.replace(/[^a-zA-Z0-9_-]/g, ""));
		if (this.isMonochrome(body)) body = this.toCurrentColor(body);
		return { body, width, height, left, top };
	}

	// Single non-white colour and no masks/gradients => treat as monochrome.
	private isMonochrome(body: string): boolean {
		if (/<mask|<image|gradient|clip-path/i.test(body)) return false;
		const colors = new Set<string>();
		for (const m of body.matchAll(
			/(?:fill|stroke)\s*[:=]\s*"?(#[0-9a-fA-F]{3,8})"?/g,
		)) {
			const c = m[1].toLowerCase();
			if (c === "#fff" || c === "#ffffff") continue;
			colors.add(c);
		}
		return colors.size <= 1;
	}

	// Replace explicit colours (except white) with currentColor.
	private toCurrentColor(body: string): string {
		return body.replace(
			/(fill|stroke)="(#[0-9a-fA-F]{3,8})"/g,
			(full, attr, color: string) => {
				const c = color.toLowerCase();
				if (c === "#fff" || c === "#ffffff") return full;
				return `${attr}="currentColor"`;
			},
		);
	}

	// Suffix internal ids and their references so multiple instances of an icon
	// (with the same mask/clip ids) don't collide on one page.
	private namespaceIds(body: string, scope: string): string {
		const ids = new Set<string>();
		for (const m of body.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
		let out = body;
		for (const id of ids) {
			const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const nid = `${id}-${scope}`;
			out = out
				.replace(new RegExp(`id="${safe}"`, "g"), `id="${nid}"`)
				.replace(new RegExp(`url\\(#${safe}\\)`, "g"), `url(#${nid})`)
				.replace(
					new RegExp(`((?:xlink:)?href)="#${safe}"`, "g"),
					`$1="#${nid}"`,
				);
		}
		return out;
	}

	getAllIcons(): Array<{ prefix: string; name: string }> {
		const allIcons: Array<{ prefix: string; name: string }> = [];
		this.allPacks().forEach((pack) => {
			Object.keys(pack.icons.icons).forEach((iconName) => {
				allIcons.push({ prefix: pack.name, name: iconName });
			});
		});
		return allIcons;
	}

	// Find the raw icon data (body/width/height) from the packs by prefix/name.
	getIconData(prefix: string, name: string) {
		const pack = this.allPacks().find((p) => p.name === prefix);
		if (!pack) return null;
		const icon = pack.icons.icons?.[name];
		if (!icon) return null;

		const packIcons = pack.icons;
		const width = icon.width ?? packIcons.width ?? 0;
		const height = icon.height ?? packIcons.height ?? 0;
		return { ...icon, width, height };
	}

	// --- Mermaid label icon rendering ---

	// Regex matching `<prefix>:<name>` for every registered icon pack.
	iconTokenRegex(): RegExp {
		const prefixes = this.allPacks()
			.map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("|");
		return new RegExp(`(${prefixes}):([\\w-]+)`, "g");
	}

	// Build an <img> with a data-URI SVG. An <img> is not a <path>, so Mermaid's
	// `.node path { fill }` colouring can't repaint it, and the SVG renders in an
	// isolated context with its original colours. Sizing via CSS .mermaid-label-icon.
	buildIconElement(prefix: string, name: string, color: string): Element | null {
		const iconData = this.getIconData(prefix, name);
		if (!iconData || !iconData.body) return null;

		let w = iconData.width;
		let h = iconData.height;
		if (!w && !h) {
			w = 24;
			h = 24;
		} else if (!w) {
			w = h;
		} else if (!h) {
			h = w;
		}

		const left = iconData.left ?? 0;
		const top = iconData.top ?? 0;
		const viewBox = `${left} ${top} ${w} ${h}`;
		// Bake the colour into the (isolated) data-URI SVG so `currentColor` icons
		// resolve to the label's intended icon colour instead of black.
		const colorStyle = color ? ` style="color:${color}"` : "";
		const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="${viewBox}"${colorStyle} preserveAspectRatio="xMidYMid meet">${iconData.body}</svg>`;

		const img = document.createElement("img");
		img.addClass("mermaid-label-icon");
		img.src = "data:image/svg+xml," + encodeURIComponent(svgStr);
		// MUST stay empty: caption plugins (e.g. wk-image-caption) turn any
		// non-empty alt into a caption <div> INSIDE the mermaid label, which
		// our pipeline observer answers with an icon re-render - an endless
		// observer ping-pong that hard-freezes the renderer. Token lives in
		// aria-label for accessibility/debugging instead.
		img.alt = "";
		img.setAttribute("aria-label", `${prefix}:${name}`);
		return img;
	}

	// Replace icon tokens inside a single label element's text nodes.
	private processLabel(labelEl: HTMLElement) {
		if (labelEl.dataset.mermaidIconsDone === "1") return;
		if (!this.iconTokenRegex().test(labelEl.textContent || "")) {
			labelEl.dataset.mermaidIconsDone = "1";
			return;
		}

		// Icon colour: a theme-settable CSS var, else the label's text colour.
		const cs = getComputedStyle(labelEl);
		const iconColor = (
			cs.getPropertyValue("--mermaid-label-icon-color").trim() ||
			cs.color ||
			""
		).trim();
		let added = false;

		const walker = document.createTreeWalker(labelEl, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

		for (const tn of textNodes) {
			const text = tn.nodeValue || "";
			const re = this.iconTokenRegex();
			if (!re.test(text)) continue;
			re.lastIndex = 0;

			const frag = document.createDocumentFragment();
			let last = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) {
					frag.appendChild(document.createTextNode(text.slice(last, m.index)));
				}
				const iconEl = this.buildIconElement(m[1], m[2], iconColor);
				if (iconEl) {
					frag.appendChild(iconEl);
					added = true;
				} else {
					frag.appendChild(document.createTextNode(m[0]));
				}
				last = m.index + m[0].length;
			}
			if (last < text.length) {
				frag.appendChild(document.createTextNode(text.slice(last)));
			}
			tn.parentNode?.replaceChild(frag, tn);
		}

		if (added) this.resizeLabelBox(labelEl);
		labelEl.dataset.mermaidIconsDone = "1";
	}

	// Mermaid sizes the node box from the label text BEFORE we inject the icon,
	// so a larger icon overflows. Grow the foreignObject + node rect to fit the
	// real content and re-centre (only ever grows; never shrinks).
	private resizeLabelBox(labelEl: HTMLElement) {
		const fo = labelEl.closest(
			"foreignObject",
		) as SVGForeignObjectElement | null;
		if (!fo) return;
		const labelG = fo.parentElement;
		const shape = labelEl.closest(".node, .icon-shape");
		const rect = shape?.querySelector(
			"rect.label-container, rect.basic",
		) as SVGRectElement | null;

		const content = (labelEl.querySelector("p") as HTMLElement) || labelEl;
		const needW = Math.ceil(content.scrollWidth);
		const needH = Math.ceil(content.scrollHeight);
		if (!needW || !needH) return;

		const foW = fo.width.baseVal.value;
		const foH = fo.height.baseVal.value;
		if (needH <= foH + 1 && needW <= foW + 1) return;

		const newFoW = Math.max(needW, foW);
		const newFoH = Math.max(needH, foH);
		fo.setAttribute("width", String(newFoW));
		fo.setAttribute("height", String(newFoH));
		labelG?.setAttribute("transform", `translate(${-newFoW / 2}, ${-newFoH / 2})`);
		if (rect) {
			const padX = (rect.width.baseVal.value - foW) / 2;
			const padY = (rect.height.baseVal.value - foH) / 2;
			const newRectW = newFoW + 2 * padX;
			const newRectH = newFoH + 2 * padY;
			rect.setAttribute("width", String(newRectW));
			rect.setAttribute("height", String(newRectH));
			rect.setAttribute("x", String(-newRectW / 2));
			rect.setAttribute("y", String(-newRectH / 2));
		}
	}

	// Render icon tokens in Mermaid labels found under `root` (.nodeLabel /
	// .edgeLabel are Mermaid-only classes, so this never touches other content).
	processLabels(root: ParentNode) {
		root
			.querySelectorAll<HTMLElement>(".nodeLabel, .edgeLabel")
			.forEach((el) => this.processLabel(el));
	}

	// Clear the processed flags under `root` (or the whole document) and
	// re-render, e.g. once custom packs have finished loading or a label
	// re-rendered while a diagram was engaged.
	rescanLabels(root: ParentNode = document.body) {
		root
			.querySelectorAll<HTMLElement>(".nodeLabel, .edgeLabel")
			.forEach((el) => {
				delete el.dataset.mermaidIconsDone;
			});
		this.processLabels(root);
	}

	// Inline `<code>` preview for the editor (mermaid icon tokens).
	processInlineCode(element: HTMLElement) {
		const codeBlocks = element.querySelectorAll("code");
		codeBlocks.forEach((code) => {
			const text = code.textContent || "";
			const matches = text.matchAll(this.iconTokenRegex());
			for (const match of matches) {
				const iconData = this.getIconData(match[1], match[2]);
				if (iconData && iconData.body) {
					let w = iconData.width;
					let h = iconData.height;
					if (!w && !h) {
						w = 32;
						h = 32;
					} else if (!w) {
						w = h;
					} else if (!h) {
						h = w;
					}
					const left = iconData.left ?? 0;
					const top = iconData.top ?? 0;
					const viewBox = `${left} ${top} ${w} ${h}`;
					const iconSpan = document.createElement("span");
					iconSpan.addClass("mermaid-icon-preview-inline");
					const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" preserveAspectRatio="xMidYMid meet" style="width:16px; height:16px; display:block;">${iconData.body}</svg>`;
					setSvg(iconSpan, svg);
					code.parentNode?.insertBefore(iconSpan, code);
				}
			}
		});
	}
}

// --- Icon picker modal (Insert Mermaid icon command) ---
export class IconModal extends FuzzySuggestModal<{ prefix: string; name: string }> {
	private readonly icons: IconManager;
	private readonly onChoose: (result: string) => void;

	constructor(
		app: App,
		icons: IconManager,
		onChoose: (result: string) => void,
	) {
		super(app);
		this.icons = icons;
		this.onChoose = onChoose;
		this.setPlaceholder("Icons durchsuchen…");
	}

	getItems(): { prefix: string; name: string }[] {
		return this.icons.getAllIcons();
	}

	getItemText(item: { prefix: string; name: string }): string {
		return `${item.prefix}:${item.name}`;
	}

	renderSuggestion(
		item: FuzzyMatch<{ prefix: string; name: string }>,
		el: HTMLElement,
	) {
		super.renderSuggestion(item, el);

		const textContent = [];
		while (el.firstChild) {
			textContent.push(el.firstChild);
			el.removeChild(el.firstChild);
		}

		el.addClass("mermaid-icon-suggestion");
		const iconContainer = el.createDiv("mermaid-icon-suggestion-icon");
		const textContainer = el.createDiv("mermaid-icon-suggestion-text");
		textContent.forEach((node) => textContainer.appendChild(node));

		const iconData = this.icons.getIconData(item.item.prefix, item.item.name);
		if (iconData && iconData.body) {
			let w = iconData.width;
			let h = iconData.height;
			if (!w && !h) {
				w = 32;
				h = 32;
			} else if (!w) {
				w = h;
			} else if (!h) {
				h = w;
			}
			const left = iconData.left ?? 0;
			const top = iconData.top ?? 0;
			const viewBox = `${left} ${top} ${w} ${h}`;
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="32" height="32" preserveAspectRatio="xMidYMid meet" style="width:32px; height:32px; display:block;">${iconData.body}</svg>`;
			setSvg(iconContainer, svg);
		}
	}

	onChooseItem(
		item: { prefix: string; name: string },
		_evt: MouseEvent | KeyboardEvent,
	): void {
		this.onChoose(`${item.prefix}:${item.name}`);
	}
}
