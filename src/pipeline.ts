import type MermaidToolkitPlugin from "./main";
import type { IconManager } from "./icons";
import type { ZoomManager } from "./zoom";

const MERMAID_SVG_SELECTOR = '.mermaid svg, svg[id^="mermaid-"]';

// The fullscreen modal shows a CLONE of an already-wrapped diagram; it must
// never be re-processed (re-wrapping the clone breaks the modal layout).
function inModal(el: Element): boolean {
	return !!el.closest(".mermaid-zoom-modal");
}

// The single processing pipeline. One MutationObserver watches for newly-added
// Mermaid SVGs (scoped - it never full-scans the document on unrelated
// mutations) plus workspace events. For every SVG the deterministic order is:
//   (1) replace icon tokens in labels  ->  (2) measure  ->  (3) wrap for zoom.
// A label mutation inside an already-engaged diagram disengages it and
// re-measures, so icons that arrive late never desync the frozen geometry.
export class Pipeline {
	private readonly plugin: MermaidToolkitPlugin;
	private readonly icons: IconManager;
	private readonly zoom: ZoomManager;

	private observer?: MutationObserver;
	private flushTimer: number | null = null;
	private readonly pendingNew = new Set<SVGSVGElement>();
	private readonly pendingRemeasure = new Set<SVGSVGElement>();
	private readonly processed = new WeakSet<SVGSVGElement>();

	constructor(
		plugin: MermaidToolkitPlugin,
		icons: IconManager,
		zoom: ZoomManager,
	) {
		this.plugin = plugin;
		this.icons = icons;
		this.zoom = zoom;
	}

	start() {
		this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
		this.observer.observe(document.body, { childList: true, subtree: true });
		this.plugin.register(() => this.observer?.disconnect());

		// Initial pass once the layout is ready.
		this.plugin.app.workspace.onLayoutReady(() => this.scanAll());

		// Re-scan on the coarse workspace events (new panes / files rendered).
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("layout-change", () => this.scanAll()),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", () => this.scanAll()),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("file-open", () => {
				window.setTimeout(() => this.scanAll(), 200);
			}),
		);
	}

	stop() {
		this.observer?.disconnect();
		this.observer = undefined;
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingNew.clear();
		this.pendingRemeasure.clear();
	}

	private onMutations(mutations: MutationRecord[]) {
		for (const mut of mutations) {
			mut.addedNodes.forEach((node) => {
				if (!(node instanceof Element)) return;

				// Newly-added Mermaid SVGs (the element itself or inside it).
				if (node.matches(MERMAID_SVG_SELECTOR) && !inModal(node)) {
					this.pendingNew.add(node as unknown as SVGSVGElement);
				}
				node
					.querySelectorAll<SVGSVGElement>(MERMAID_SVG_SELECTOR)
					.forEach((s) => {
						if (!inModal(s)) this.pendingNew.add(s);
					});
				if (node instanceof SVGSVGElement && node.closest(".mermaid") && !inModal(node)) {
					this.pendingNew.add(node);
				}

				// Something changed inside an already-wrapped diagram (e.g. a
				// live-preview re-render or late icon shape): mark its svg for a
				// re-measure. disengageSvg() is a no-op unless it is engaged.
				const wrapper = node.closest(".mermaid-zoom-content");
				const wrappedSvg = wrapper?.querySelector("svg") as SVGSVGElement | null;
				if (wrappedSvg) this.pendingRemeasure.add(wrappedSvg);
			});
		}
		if (this.pendingNew.size > 0 || this.pendingRemeasure.size > 0) {
			this.scheduleFlush();
		}
	}

	private scanAll() {
		document
			.querySelectorAll<SVGSVGElement>(MERMAID_SVG_SELECTOR)
			.forEach((s) => {
				if (!this.processed.has(s) && !inModal(s)) this.pendingNew.add(s);
			});
		if (this.pendingNew.size > 0) this.scheduleFlush();
	}

	private scheduleFlush() {
		if (this.flushTimer !== null) return;
		// Mermaid may still be mutating an SVG when the observer first sees it; a
		// short delay lets subgraph bounds settle before we measure/wrap.
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			requestAnimationFrame(() => this.flush());
		}, 50);
	}

	private flush() {
		const newSvgs = Array.from(this.pendingNew);
		const remeasure = Array.from(this.pendingRemeasure);
		this.pendingNew.clear();
		this.pendingRemeasure.clear();

		// Disconnect while we mutate the DOM (icon <img>, zoom wrappers) so our
		// own changes do not feed back into the observer.
		this.observer?.disconnect();
		try {
			for (const svg of newSvgs) {
				if (!svg.isConnected) continue;
				// (1) Icons first, so node boxes grow before geometry is measured.
				this.icons.processLabels(svg);
				// (2)+(3) Measure + wrap (wrap freezes geometry lazily on engage).
				if (!this.zoom.hasZoomContainer(svg)) {
					this.zoom.wrap(svg);
				}
				this.processed.add(svg);
			}

			for (const svg of remeasure) {
				if (!svg.isConnected) continue;
				if (newSvgs.includes(svg)) continue; // freshly wrapped above
				// A label re-rendered inside a wrapped diagram: if it was engaged,
				// drop to native and re-run icons so the next engage re-measures.
				const wasEngaged = this.zoom.disengageSvg(svg);
				if (wasEngaged) this.icons.rescanLabels(svg);
			}
		} finally {
			this.observer?.observe(document.body, { childList: true, subtree: true });
		}
	}

	// Clear processed flags and re-run (used after custom icon packs finish
	// loading so tokens left as plain text get rendered).
	rescan() {
		this.scanAll();
	}
}
