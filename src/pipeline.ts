import type MermaidToolkitPlugin from "./main";
import type { IconManager } from "./icons";
import type { ZoomManager } from "./zoom";

const MERMAID_SVG_SELECTOR = '.mermaid svg, svg[id^="mermaid-"]';

// The fullscreen modal shows a CLONE of an already-wrapped diagram; it must
// never be re-processed (re-wrapping the clone breaks the modal layout).
function inModal(el: Element): boolean {
	return !!el.closest(".mermaid-zoom-modal");
}

// Automatic label contrast: diagrams may bring their own classDef fills.
// When a node surface is dark, force white label text - inline !important
// beats the theme's colour rules and survives modal clones and export
// serialisation. Same YIQ threshold as the uvitas-charts datalabels.
function isDarkFill(color: string): boolean {
	const c = color.trim().toLowerCase();
	if (!c || c === "none" || c === "transparent") return false;
	let r: number, g: number, b: number;
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
	const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
	if (hex) {
		let h = hex[1];
		if (h.length === 3) h = h.split("").map((x) => x + x).join("");
		r = parseInt(h.slice(0, 2), 16);
		g = parseInt(h.slice(2, 4), 16);
		b = parseInt(h.slice(4, 6), 16);
	} else if (rgb) {
		r = +rgb[1]; g = +rgb[2]; b = +rgb[3];
	} else {
		return false;
	}
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.55;
}

function whitenLabelsWithin(scope: Element) {
	scope
		.querySelectorAll<HTMLElement>(
			".nodeLabel, foreignObject div, foreignObject span, foreignObject p, i",
		)
		.forEach((el) => el.style.setProperty("color", "#ffffff", "important"));
	scope
		.querySelectorAll<SVGElement>("text, tspan")
		.forEach((t) => t.style.setProperty("fill", "#ffffff", "important"));
}

// Area shapes only: bare <path> is also how mermaid draws axes/arrows (whose
// computed fill is the black default), so paths count only when their class
// marks them as a node surface (timeline/journey draw boxes as path.node-bkg).
function isAreaShape(el: Element): boolean {
	if (/^(rect|polygon|circle|ellipse)$/i.test(el.tagName)) return true;
	return (
		el.tagName.toLowerCase() === "path" &&
		/(^|\s|-)(bkg|node)/i.test(el.getAttribute("class") ?? "")
	);
}

// Fits the viewBox to what is actually drawn - in BOTH directions.
//
// Mermaid sizes the box from the layout it planned; injecting icons widens node
// boxes afterwards (a node grows around its centre), and mermaid itself leaves
// slack (a gantt's "today" marker sits far right of the last bar). Too small a
// box clips one side and pushes the rest off-centre; too large a box pads the
// diagram with dead space. Trimming as well as growing keeps it centred AND
// tight - PAD is the breathing room that survives either way.
export function fitViewBox(svg: SVGSVGElement) {
	const PAD = 8;
	const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
	if (vb.length !== 4 || vb.some((n) => !isFinite(n)) || vb[2] <= 0) return;
	// The gantt "today" marker is a pointer, not content: when today lies outside
	// the plotted range it sits far off to the side and would stretch the box
	// across a wide empty gap. Measure without it.
	const markers = Array.from(svg.querySelectorAll<SVGElement>(".today"));
	const prevDisplay = markers.map((m) => m.style.display);
	markers.forEach((m) => (m.style.display = "none"));
	let bb: DOMRect | null = null;
	try {
		bb = svg.getBBox();
	} catch {
		bb = null; // not rendered yet
	}
	markers.forEach((m, i) => (m.style.display = prevDisplay[i]));
	if (!bb || bb.width <= 0 || bb.height <= 0) return;
	const left = bb.x - PAD;
	const top = bb.y - PAD;
	const width = bb.width + 2 * PAD;
	const height = bb.height + 2 * PAD;
	if (
		Math.abs(left - vb[0]) < 1 &&
		Math.abs(top - vb[1]) < 1 &&
		Math.abs(width - vb[2]) < 1 &&
		Math.abs(height - vb[3]) < 1
	) {
		return; // sub-pixel churn - not worth a re-layout
	}
	svg.setAttribute("viewBox", `${left} ${top} ${width} ${height}`);
}

export function applyLabelContrast(svg: SVGSVGElement) {
	svg.querySelectorAll<SVGGElement>("g.node").forEach((node) => {
		const shape = node.querySelector<SVGGraphicsElement>(
			"rect, polygon, circle, ellipse, path",
		);
		if (!shape) return;
		if (!isDarkFill(getComputedStyle(shape).fill)) return;
		whitenLabelsWithin(node);
	});

	// Diagram types without g.node groups (timeline, journey, ...) pair an
	// anonymous <g> holding a dark area shape with sibling text/foreignObject
	// children. Only direct children are touched so nested lighter nodes keep
	// their own label colour.
	svg.querySelectorAll<SVGGElement>("g").forEach((g) => {
		if (g.classList.contains("node") || g.closest("g.node")) return;
		const kids = Array.from(g.children);
		const shape = kids.find(isAreaShape) as SVGGraphicsElement | undefined;
		if (!shape || !isDarkFill(getComputedStyle(shape).fill)) return;
		kids.forEach((k) => {
			const tag = k.tagName.toLowerCase();
			if (tag === "text") {
				(k as SVGElement).style.setProperty("fill", "#ffffff", "important");
				k.querySelectorAll<SVGElement>("tspan").forEach((t) =>
					t.style.setProperty("fill", "#ffffff", "important"),
				);
			} else if (tag === "foreignobject") {
				whitenLabelsWithin(k);
			} else if (tag === "g") {
				// A nested group with its own surface owns its label colour -
				// it gets its own pass (its fill may well be lighter).
				if (!Array.from(k.children).some(isAreaShape)) whitenLabelsWithin(k);
			}
		});
	});
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
				// (1a) Icons made the node boxes wider than mermaid planned for -
				// re-fit the viewBox before anything measures the diagram.
				fitViewBox(svg);
				// (1b) Contrast pass: white labels on dark custom node fills.
				applyLabelContrast(svg);
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
