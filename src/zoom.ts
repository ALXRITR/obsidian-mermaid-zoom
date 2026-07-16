import type { MermaidToolkitSettings } from "./settings";

interface ZoomState {
	scale: number;
	minScale: number;
	maxScale: number;
	isDragging: boolean;
	startX: number;
	startY: number;
	translateX: number;
	translateY: number;
	scaleIndicator?: HTMLElement;
	svg: SVGSVGElement;
	container: HTMLElement;
	svgOriginalWidth: number;
	svgOriginalHeight: number;
	userResizedHeight: boolean;
	engaged: boolean;
	engagedWidth: number;
	baseOffsetX: number;
	baseOffsetY: number;
	savedSvg?: {
		attrWidth: string | null;
		attrHeight: string | null;
		styleWidth: string;
		styleHeight: string;
		styleMaxWidth: string;
		styleMaxHeight: string;
		styleOverflow: string;
	};
}

interface SvgBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

// The zoom/pan engine ported verbatim from obsidian-mermaid-zoom. It wraps each
// rendered Mermaid SVG in a container, freezes geometry on first interaction
// (engage), and drives wheel/pinch/touch zoom plus a fullscreen modal.
export class ZoomManager {
	private readonly getSettings: () => MermaidToolkitSettings;
	private readonly zoomStates = new Map<HTMLElement, ZoomState>();
	private readonly defaultMinScale = 0.1;
	private readonly defaultMaxScale = 5;
	private readonly defaultScale = 1;
	private resizeObserver?: ResizeObserver;

	constructor(getSettings: () => MermaidToolkitSettings) {
		this.getSettings = getSettings;
	}

	setupResizeObserver() {
		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const container = entry.target as HTMLElement;
				const contentWrapper = container.querySelector(
					".mermaid-zoom-content",
				) as HTMLElement;
				if (!contentWrapper) continue;
				const state = this.zoomStates.get(contentWrapper);
				if (!state || !state.engaged) continue; // at rest: native CSS handles resizes
				// A pane-width change while zoomed: drop back to native rather than
				// re-fitting a transformed diagram.
				if (Math.abs(container.clientWidth - state.engagedWidth) > 1) {
					this.disengage(contentWrapper, state);
				}
			}
		});
	}

	hasZoomContainer(svg: SVGSVGElement): boolean {
		const mermaidContainer = svg.closest(".mermaid");
		const parent = mermaidContainer?.parentElement || svg.parentElement;
		return parent?.hasClass("mermaid-zoom-content") ?? false;
	}

	// Disengage any wrapped-and-engaged diagram for this svg (used by the
	// pipeline when a label re-rendered while zoomed - forces a fresh measure).
	// Returns true if a diagram was actually disengaged.
	disengageSvg(svg: SVGSVGElement): boolean {
		for (const [contentWrapper, state] of this.zoomStates) {
			if (state.svg === svg && state.engaged) {
				this.disengage(contentWrapper, state);
				return true;
			}
		}
		return false;
	}

	// After a CSS/settings change engaged diagrams drop back to native so new
	// spacing applies.
	disengageAll() {
		for (const [contentWrapper, state] of this.zoomStates) {
			if (state.engaged) this.disengage(contentWrapper, state);
		}
	}

	wrap(svg: SVGSVGElement): boolean {
		if (!svg.parentElement) return false;
		if (this.hasZoomContainer(svg)) return false;

		const mermaidContainer = svg.closest(".mermaid") as HTMLElement;
		const targetParent = mermaidContainer?.parentElement || svg.parentElement;
		const targetElement = mermaidContainer || svg;

		if (!targetParent) return false;

		// Native at rest: do NOT touch the svg here. Geometry is only frozen once
		// the user actually zooms/pans (ensureEngaged).
		const container = createDiv("mermaid-zoom-container");
		container.style.cssText = `
			position: relative;
			overflow: hidden;
			width: 100%;
			box-sizing: border-box;
		`;

		const contentWrapper = container.createDiv("mermaid-zoom-content");
		contentWrapper.style.cssText = `
			transform-origin: 0 0;
			transition: transform 0.1s ease-out;
			width: 100%;
		`;

		targetParent.insertBefore(container, targetElement);
		contentWrapper.appendChild(targetElement);

		const state: ZoomState = {
			scale: this.defaultScale,
			minScale: this.defaultMinScale,
			maxScale: this.defaultMaxScale,
			isDragging: false,
			startX: 0,
			startY: 0,
			translateX: 0,
			translateY: 0,
			svg: svg,
			container: container,
			svgOriginalWidth: 0,
			svgOriginalHeight: 0,
			userResizedHeight: false,
			engaged: false,
			engagedWidth: 0,
			baseOffsetX: 0,
			baseOffsetY: 0,
		};
		this.zoomStates.set(contentWrapper, state);

		this.createControls(container, contentWrapper, state);
		this.addWheelZoom(container, contentWrapper, state);
		this.addDragPan(container, contentWrapper, state);
		this.addTouchGestures(container, contentWrapper, state);

		this.resizeObserver?.observe(container);
		return true;
	}

	private getSvgContentSize(svg: SVGSVGElement): { width: number; height: number } {
		const contentBox = this.getSvgContentBox(svg);
		if (contentBox) {
			const padding = 12;
			const x = contentBox.x - padding;
			const y = contentBox.y - padding;
			const width = contentBox.width + padding * 2;
			const height = contentBox.height + padding * 2;

			svg.setAttribute(
				"viewBox",
				`${this.formatSvgNumber(x)} ${this.formatSvgNumber(y)} ${this.formatSvgNumber(width)} ${this.formatSvgNumber(height)}`,
			);
			return { width, height };
		}

		const viewBox = svg.viewBox?.baseVal;
		if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
			return { width: viewBox.width, height: viewBox.height };
		}

		const attrWidth = this.parseSvgLength(svg.getAttribute("width"));
		const attrHeight = this.parseSvgLength(svg.getAttribute("height"));
		if (attrWidth && attrHeight) {
			return { width: attrWidth, height: attrHeight };
		}

		const rect = svg.getBoundingClientRect();
		return {
			width: rect.width || svg.clientWidth || 300,
			height: rect.height || svg.clientHeight || 200,
		};
	}

	private getSvgContentBox(svg: SVGSVGElement): SvgBox | undefined {
		const currentViewBox = this.getCurrentSvgViewBox(svg);
		const elements = Array.from(
			svg.querySelectorAll(
				"path, rect, circle, ellipse, polygon, polyline, line, text, foreignObject, image, use",
			),
		) as SVGGraphicsElement[];

		let union: SvgBox | undefined;
		for (const element of elements) {
			if (this.shouldIgnoreSvgContentElement(element)) continue;

			const box = this.getElementSvgBox(svg, element);
			if (!box || box.width <= 0 || box.height <= 0) continue;
			if (this.isFullCanvasBackground(element, box, currentViewBox)) continue;

			union = union ? this.unionSvgBoxes(union, box) : box;
		}

		if (union && union.width > 0 && union.height > 0) {
			return union;
		}

		try {
			const bbox = svg.getBBox();
			if (bbox.width > 0 && bbox.height > 0) {
				return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
			}
		} catch {
			// getBBox can throw for detached or not-yet-rendered SVGs.
		}

		return undefined;
	}

	private parseSvgLength(value: string | null): number | undefined {
		if (!value) return undefined;
		const trimmed = value.trim();
		if (!trimmed || trimmed.endsWith("%")) return undefined;

		const match = trimmed.match(/^([0-9]*\.?[0-9]+)/);
		if (!match) return undefined;

		const parsed = Number(match[1]);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}

	private getCurrentSvgViewBox(svg: SVGSVGElement): SvgBox | undefined {
		const viewBox = svg.viewBox?.baseVal;
		if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
			return { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height };
		}

		const width = this.parseSvgLength(svg.getAttribute("width"));
		const height = this.parseSvgLength(svg.getAttribute("height"));
		if (width && height) {
			return { x: 0, y: 0, width, height };
		}

		return undefined;
	}

	private shouldIgnoreSvgContentElement(element: SVGGraphicsElement): boolean {
		if (
			element.closest(
				"defs, marker, clipPath, mask, pattern, linearGradient, radialGradient, symbol",
			)
		) {
			return true;
		}

		const label = `${element.id} ${element.getAttribute("class") ?? ""}`;
		if (/\b(background|canvas|diagram-background)\b/i.test(label)) {
			return true;
		}

		const style = getComputedStyle(element);
		return (
			style.display === "none" ||
			style.visibility === "hidden" ||
			Number(style.opacity) === 0
		);
	}

	private isFullCanvasBackground(
		element: SVGGraphicsElement,
		box: SvgBox,
		viewBox: SvgBox | undefined,
	): boolean {
		if (!viewBox || element.tagName.toLowerCase() !== "rect") return false;

		const label = `${element.id} ${element.getAttribute("class") ?? ""} ${element.parentElement?.getAttribute("class") ?? ""}`;
		if (/\b(cluster|node|task|actor|section|label|legend)\b/i.test(label)) return false;

		const coversWidth = box.width >= viewBox.width * 0.95;
		const coversHeight = box.height >= viewBox.height * 0.95;
		return coversWidth && coversHeight;
	}

	private getElementSvgBox(
		svg: SVGSVGElement,
		element: SVGGraphicsElement,
	): SvgBox | undefined {
		const ctm = svg.getScreenCTM();
		if (ctm) {
			const rect = element.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				return this.clientRectToSvgBox(svg, rect, ctm.inverse());
			}
		}

		try {
			const bbox = element.getBBox();
			if (bbox.width > 0 && bbox.height > 0) {
				return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
			}
		} catch {
			// Ignore elements that cannot report a box.
		}

		return undefined;
	}

	private clientRectToSvgBox(
		svg: SVGSVGElement,
		rect: DOMRect,
		inverseCtm: DOMMatrix,
	): SvgBox {
		const point = svg.createSVGPoint();
		const corners = [
			[rect.left, rect.top],
			[rect.right, rect.top],
			[rect.right, rect.bottom],
			[rect.left, rect.bottom],
		].map(([x, y]) => {
			point.x = x;
			point.y = y;
			return point.matrixTransform(inverseCtm);
		});

		const xs = corners.map((corner) => corner.x);
		const ys = corners.map((corner) => corner.y);
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);

		return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
	}

	private unionSvgBoxes(a: SvgBox, b: SvgBox): SvgBox {
		const minX = Math.min(a.x, b.x);
		const minY = Math.min(a.y, b.y);
		const maxX = Math.max(a.x + a.width, b.x + b.width);
		const maxY = Math.max(a.y + a.height, b.y + b.height);
		return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
	}

	private formatSvgNumber(value: number): string {
		return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "0";
	}

	private lockSvgDisplaySize(
		svg: SVGSVGElement,
		size: { width: number; height: number },
	) {
		svg.setAttribute("width", this.formatSvgNumber(size.width));
		svg.setAttribute("height", this.formatSvgNumber(size.height));
		svg.style.width = `${size.width}px`;
		svg.style.height = `${size.height}px`;
		svg.style.maxWidth = "none";
		svg.style.maxHeight = "none";
		svg.style.overflow = "visible";
	}

	// Freeze the current native geometry so transforms have a stable baseline.
	private ensureEngaged(contentWrapper: HTMLElement, state: ZoomState) {
		if (state.engaged) return;
		const container = state.container;
		const svg = state.svg;
		const pre = svg.getBoundingClientRect();
		if (pre.width < 2 || pre.height < 2) return; // hidden/collapsed

		state.savedSvg = {
			attrWidth: svg.getAttribute("width"),
			attrHeight: svg.getAttribute("height"),
			styleWidth: svg.style.width,
			styleHeight: svg.style.height,
			styleMaxWidth: svg.style.maxWidth,
			styleMaxHeight: svg.style.maxHeight,
			styleOverflow: svg.style.overflow,
		};

		this.lockSvgDisplaySize(svg, { width: pre.width, height: pre.height });
		container.style.height = `${container.offsetHeight}px`;
		container.addClass("is-engaged");

		const post = svg.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		const cs = getComputedStyle(container);
		const contentLeft =
			containerRect.left +
			(parseFloat(cs.borderLeftWidth) || 0) +
			(parseFloat(cs.paddingLeft) || 0);
		const contentTop =
			containerRect.top +
			(parseFloat(cs.borderTopWidth) || 0) +
			(parseFloat(cs.paddingTop) || 0);
		state.baseOffsetX = post.left - contentLeft;
		state.baseOffsetY = post.top - contentTop;

		state.svgOriginalWidth = pre.width;
		state.svgOriginalHeight = pre.height;
		state.scale = 1;
		state.translateX = pre.left - post.left;
		state.translateY = pre.top - post.top;
		state.engaged = true;
		state.engagedWidth = container.clientWidth;
		this.updateTransform(contentWrapper, state);
	}

	// Back to native: undo every freeze so the browser's responsive layout
	// takes over again.
	private disengage(contentWrapper: HTMLElement, state: ZoomState) {
		const svg = state.svg;
		const saved = state.savedSvg;
		if (saved) {
			if (saved.attrWidth === null) svg.removeAttribute("width");
			else svg.setAttribute("width", saved.attrWidth);
			if (saved.attrHeight === null) svg.removeAttribute("height");
			else svg.setAttribute("height", saved.attrHeight);
			svg.style.width = saved.styleWidth;
			svg.style.height = saved.styleHeight;
			svg.style.maxWidth = saved.styleMaxWidth;
			svg.style.maxHeight = saved.styleMaxHeight;
			svg.style.overflow = saved.styleOverflow;
			state.savedSvg = undefined;
		}
		state.container.style.height = "";
		state.container.removeClass("is-engaged");
		contentWrapper.style.transform = "";
		state.scale = 1;
		state.translateX = 0;
		state.translateY = 0;
		state.engaged = false;
		state.engagedWidth = 0;
		state.userResizedHeight = false;
		if (state.scaleIndicator) {
			state.scaleIndicator.textContent = "100%";
		}
	}

	private openFullscreenModal(state: ZoomState) {
		const modal = document.createElement("div");
		modal.className = "mermaid-zoom-modal";
		modal.style.cssText = `
			position: fixed;
			top: 0;
			left: 0;
			width: 100vw;
			height: 100vh;
			background: var(--background-primary);
			z-index: 9999;
			display: flex;
			flex-direction: column;
		`;

		const header = document.createElement("div");
		header.className = "mermaid-zoom-modal-header";
		header.style.cssText = `
			display: flex;
			justify-content: flex-end;
			padding: 10px 15px;
			background: var(--background-secondary);
			border-bottom: 1px solid var(--background-modifier-border);
		`;

		const closeBtn = document.createElement("button");
		closeBtn.className = "mermaid-zoom-modal-close";
		closeBtn.textContent = "✕";
		closeBtn.style.cssText = `
			width: 32px;
			height: 32px;
			border: none;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border-radius: 4px;
			cursor: pointer;
			font-size: 18px;
			display: flex;
			align-items: center;
			justify-content: center;
			transition: background 0.2s;
		`;
		header.appendChild(closeBtn);

		const content = document.createElement("div");
		content.className = "mermaid-zoom-modal-content";
		content.style.cssText = `
			flex: 1;
			overflow: hidden;
			position: relative;
			display: flex;
			align-items: center;
			justify-content: center;
		`;

		const modalZoomContainer = document.createElement("div");
		modalZoomContainer.className = "mermaid-zoom-modal-zoom-container";
		modalZoomContainer.style.cssText = `
			width: 100%;
			height: 100%;
			overflow: hidden;
			position: relative;
		`;

		const modalContentWrapper = document.createElement("div");
		modalContentWrapper.className = "mermaid-zoom-modal-wrapper mermaid";
		modalContentWrapper.style.cssText = `
			transform-origin: 0 0;
			transition: transform 0.1s ease-out;
			width: fit-content;
			position: absolute;
		`;

		const svgClone = state.svg.cloneNode(true) as SVGSVGElement;
		modalContentWrapper.appendChild(svgClone);
		modalZoomContainer.appendChild(modalContentWrapper);
		content.appendChild(modalZoomContainer);

		const controls = document.createElement("div");
		controls.className = "mermaid-zoom-modal-controls";
		controls.style.cssText = `
			position: absolute;
			bottom: 20px;
			right: 20px;
			display: flex;
			gap: 5px;
			background: var(--background-secondary);
			padding: 8px;
			border-radius: 8px;
			box-shadow: 0 4px 12px rgba(0,0,0,0.2);
		`;

		const modalState: ZoomState = {
			scale: 1,
			minScale: this.defaultMinScale,
			maxScale: this.defaultMaxScale,
			isDragging: false,
			startX: 0,
			startY: 0,
			translateX: 0,
			translateY: 0,
			svg: svgClone,
			container: modalZoomContainer,
			svgOriginalWidth: 0,
			svgOriginalHeight: 0,
			userResizedHeight: true,
			engaged: true, // modal geometry is always frozen; ensureEngaged no-ops
			engagedWidth: 0,
			baseOffsetX: 0,
			baseOffsetY: 0,
		};

		const zoomInBtn = document.createElement("button");
		zoomInBtn.textContent = "+";
		this.styleButton(zoomInBtn);
		zoomInBtn.addEventListener("click", () =>
			this.zoom(modalContentWrapper, modalState, 1.2),
		);

		const zoomOutBtn = document.createElement("button");
		zoomOutBtn.textContent = "-";
		this.styleButton(zoomOutBtn);
		zoomOutBtn.addEventListener("click", () =>
			this.zoom(modalContentWrapper, modalState, 0.8),
		);

		const resetBtn = document.createElement("button");
		resetBtn.textContent = "⟲";
		this.styleButton(resetBtn);
		resetBtn.addEventListener("click", () => {
			this.fitToContainerModal(modalZoomContainer, modalContentWrapper, modalState);
		});

		const scaleIndicator = document.createElement("span");
		scaleIndicator.style.cssText = `
			padding: 4px 8px;
			font-size: 12px;
			font-family: var(--font-ui-medium);
			color: var(--text-muted);
			min-width: 45px;
			text-align: center;
		`;
		modalState.scaleIndicator = scaleIndicator;

		controls.appendChild(zoomInBtn);
		controls.appendChild(zoomOutBtn);
		controls.appendChild(resetBtn);
		controls.appendChild(scaleIndicator);
		content.appendChild(controls);

		modal.appendChild(header);
		modal.appendChild(content);

		const closeModal = () => {
			modal.remove();
			document.removeEventListener("keydown", handleKeydown);
		};

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				closeModal();
			}
		};
		document.addEventListener("keydown", handleKeydown);
		closeBtn.addEventListener("click", closeModal);
		document.body.appendChild(modal);

		this.addWheelZoom(modalZoomContainer, modalContentWrapper, modalState, false);
		this.addDragPan(modalZoomContainer, modalContentWrapper, modalState);
		this.addTouchGestures(modalZoomContainer, modalContentWrapper, modalState);

		requestAnimationFrame(() => {
			const size = this.getSvgContentSize(svgClone);
			this.lockSvgDisplaySize(svgClone, size);
			modalState.svgOriginalWidth = size.width;
			modalState.svgOriginalHeight = size.height;
			this.fitToContainerModal(modalZoomContainer, modalContentWrapper, modalState);
		});
	}

	private fitToContainerModal(
		container: HTMLElement,
		contentWrapper: HTMLElement,
		state: ZoomState,
	) {
		const padding = 40;
		const availableWidth = container.clientWidth - padding * 2;
		const availableHeight = container.clientHeight - padding * 2;

		const svgWidth = state.svgOriginalWidth;
		const svgHeight = state.svgOriginalHeight;

		const scaleX = availableWidth / svgWidth;
		const scaleY = availableHeight / svgHeight;
		const fitScale = Math.min(scaleX, scaleY, 2); // Allow up to 200% in modal

		const scaledWidth = svgWidth * fitScale;
		const scaledHeight = svgHeight * fitScale;
		const centerX = (container.clientWidth - scaledWidth) / 2;
		const centerY = (container.clientHeight - scaledHeight) / 2;

		state.scale = fitScale;
		state.translateX = centerX;
		state.translateY = centerY;
		this.updateTransform(contentWrapper, state);
	}

	private createControls(
		container: HTMLElement,
		contentWrapper: HTMLElement,
		state: ZoomState,
	) {
		const controls = container.createDiv("mermaid-zoom-controls");
		controls.style.cssText = `
			position: absolute;
			bottom: 10px;
			right: 10px;
			display: flex;
			gap: 5px;
			z-index: 100;
			background: var(--background-secondary);
			padding: 5px;
			border-radius: 5px;
			box-shadow: 0 2px 8px rgba(0,0,0,0.15);
		`;

		const zoomInBtn = controls.createEl("button", {
			text: "+",
			cls: "mermaid-zoom-btn",
		});
		this.styleButton(zoomInBtn);
		zoomInBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.zoom(contentWrapper, state, 1.2);
		});

		const zoomOutBtn = controls.createEl("button", {
			text: "-",
			cls: "mermaid-zoom-btn",
		});
		this.styleButton(zoomOutBtn);
		zoomOutBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.zoom(contentWrapper, state, 0.8);
		});

		const resetBtn = controls.createEl("button", {
			text: "⟲",
			cls: "mermaid-zoom-btn",
		});
		this.styleButton(resetBtn);
		resetBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.resetZoom(contentWrapper, state);
		});

		const scaleIndicator = controls.createEl("span", {
			cls: "mermaid-zoom-scale",
		});
		scaleIndicator.style.cssText = `
			padding: 4px 8px;
			font-size: 12px;
			font-family: var(--font-ui-medium);
			color: var(--text-muted);
			min-width: 45px;
			text-align: center;
		`;
		state.scaleIndicator = scaleIndicator;
		scaleIndicator.textContent = "100%";

		const fullscreenBtn = controls.createEl("button", {
			cls: "mermaid-zoom-btn mermaid-fullscreen-btn",
		});

		const svgNS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNS, "svg");
		svg.setAttribute("width", "24");
		svg.setAttribute("height", "24");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");

		const polyline1 = document.createElementNS(svgNS, "polyline");
		polyline1.setAttribute("points", "1,10 1,15 6,15");
		svg.appendChild(polyline1);
		const polyline2 = document.createElementNS(svgNS, "polyline");
		polyline2.setAttribute("points", "15,10 15,15 10,15");
		svg.appendChild(polyline2);
		const polyline3 = document.createElementNS(svgNS, "polyline");
		polyline3.setAttribute("points", "1,6 1,1 6,1");
		svg.appendChild(polyline3);
		const polyline4 = document.createElementNS(svgNS, "polyline");
		polyline4.setAttribute("points", "15,6 15,1 10,1");
		svg.appendChild(polyline4);

		fullscreenBtn.appendChild(svg);
		this.styleButton(fullscreenBtn);
		fullscreenBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openFullscreenModal(state);
		});

		this.addResizeHandle(container, contentWrapper, state);
	}

	private styleButton(btn: HTMLButtonElement) {
		btn.style.cssText = `
			width: 28px;
			height: 28px;
			border: none;
			background: var(--interactive-normal);
			color: var(--text-normal);
			border-radius: 4px;
			cursor: pointer;
			font-size: 16px;
			display: flex;
			align-items: center;
			justify-content: center;
			transition: background 0.2s;
		`;
	}

	private addResizeHandle(
		container: HTMLElement,
		contentWrapper: HTMLElement,
		state: ZoomState,
	) {
		const handle = container.createDiv("mermaid-resize-bottom");
		handle.style.cssText = `
			position: absolute;
			bottom: 0;
			left: 0;
			right: 0;
			height: 8px;
			cursor: ns-resize;
			z-index: 50;
		`;

		let isResizing = false;
		let startY = 0;
		let startHeight = 0;

		const onMouseDown = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			isResizing = true;
			startY = e.clientY;
			startHeight = container.offsetHeight;
			document.body.addClass("mermaid-zoom-resizing-ns");
		};

		const onMouseMove = (e: MouseEvent) => {
			if (!isResizing) return;
			e.preventDefault();
			this.ensureEngaged(contentWrapper, state);
			if (!state.engaged) return;
			const newHeight = Math.max(100, startHeight + (e.clientY - startY));
			state.userResizedHeight = true;
			container.style.height = `${newHeight}px`;

			const cs = getComputedStyle(container);
			const availW = Math.max(
				container.clientWidth -
					(parseFloat(cs.paddingLeft) || 0) -
					(parseFloat(cs.paddingRight) || 0),
				0,
			);
			const availH = Math.max(
				container.clientHeight -
					(parseFloat(cs.paddingTop) || 0) -
					(parseFloat(cs.paddingBottom) || 0),
				0,
			);
			if (state.svgOriginalWidth < 1 || state.svgOriginalHeight < 1) return;
			const fit = Math.min(
				availW / state.svgOriginalWidth,
				availH / state.svgOriginalHeight,
				state.maxScale,
			);
			state.scale = fit;
			state.translateX =
				Math.max(0, (availW - state.svgOriginalWidth * fit) / 2) -
				state.baseOffsetX * fit;
			state.translateY =
				Math.max(0, (availH - state.svgOriginalHeight * fit) / 2) -
				state.baseOffsetY * fit;
			this.updateTransform(contentWrapper, state);
		};

		const onMouseUp = () => {
			if (!isResizing) return;
			isResizing = false;
			document.body.removeClass("mermaid-zoom-resizing-ns");
		};

		handle.addEventListener("mousedown", onMouseDown);
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
	}

	private addWheelZoom(
		container: HTMLElement,
		contentWrapper: HTMLElement,
		state: ZoomState,
		respectModifier = true,
	) {
		container.addEventListener(
			"wheel",
			(e) => {
				const isPinch = e.ctrlKey;
				const hasModifier = e.ctrlKey || e.metaKey;

				if (
					respectModifier &&
					this.getSettings().requireModifierForZoom &&
					!hasModifier
				) {
					return;
				}

				e.preventDefault();
				e.stopPropagation();

				this.ensureEngaged(contentWrapper, state);
				if (!state.engaged) return;

				const rect = container.getBoundingClientRect();
				const mouseX = e.clientX - rect.left;
				const mouseY = e.clientY - rect.top;

				const intensity = isPinch ? 0.01 : 0.0015;
				const oldScale = state.scale;
				let newScale = oldScale * Math.exp(-e.deltaY * intensity);
				newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

				if (newScale !== oldScale) {
					const scaleRatio = newScale / oldScale;
					state.translateX = mouseX - (mouseX - state.translateX) * scaleRatio;
					state.translateY = mouseY - (mouseY - state.translateY) * scaleRatio;
					state.scale = newScale;
					this.updateTransform(contentWrapper, state);
				}
			},
			{ passive: false },
		);
	}

	private addDragPan(
		container: HTMLElement,
		contentWrapper: HTMLElement,
		state: ZoomState,
	) {
		container.addEventListener("mousedown", (e) => {
			if (e.button === 0) {
				e.preventDefault();
				this.ensureEngaged(contentWrapper, state);
				if (!state.engaged) return;
				state.isDragging = true;
				state.startX = e.clientX - state.translateX;
				state.startY = e.clientY - state.translateY;
				container.addClass("is-dragging");
			}
		});

		document.addEventListener("mousemove", (e) => {
			if (state.isDragging) {
				e.preventDefault();
				state.translateX = e.clientX - state.startX;
				state.translateY = e.clientY - state.startY;
				this.updateTransform(contentWrapper, state);
			}
		});

		document.addEventListener("mouseup", () => {
			if (state.isDragging) {
				state.isDragging = false;
				container.removeClass("is-dragging");
			}
		});
	}

	private addTouchGestures(
		container: HTMLElement,
		contentWrapper: HTMLElement,
		state: ZoomState,
	) {
		let initialDistance = 0;
		let initialScale = 1;

		container.addEventListener(
			"touchstart",
			(e) => {
				this.ensureEngaged(contentWrapper, state);
				if (!state.engaged) return;
				if (e.touches.length === 2) {
					const touch1 = e.touches[0];
					const touch2 = e.touches[1];
					initialDistance = Math.hypot(
						touch2.clientX - touch1.clientX,
						touch2.clientY - touch1.clientY,
					);
					initialScale = state.scale;
				} else if (e.touches.length === 1) {
					state.isDragging = true;
					state.startX = e.touches[0].clientX - state.translateX;
					state.startY = e.touches[0].clientY - state.translateY;
				}
			},
			{ passive: false },
		);

		container.addEventListener(
			"touchmove",
			(e) => {
				e.preventDefault();

				if (e.touches.length === 2) {
					const touch1 = e.touches[0];
					const touch2 = e.touches[1];
					const currentDistance = Math.hypot(
						touch2.clientX - touch1.clientX,
						touch2.clientY - touch1.clientY,
					);

					const scaleRatio = currentDistance / initialDistance;
					let newScale = initialScale * scaleRatio;
					newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

					state.scale = newScale;
					this.updateTransform(contentWrapper, state);
				} else if (e.touches.length === 1 && state.isDragging) {
					state.translateX = e.touches[0].clientX - state.startX;
					state.translateY = e.touches[0].clientY - state.startY;
					this.updateTransform(contentWrapper, state);
				}
			},
			{ passive: false },
		);

		container.addEventListener("touchend", () => {
			state.isDragging = false;
		});
	}

	private zoom(contentWrapper: HTMLElement, state: ZoomState, factor: number) {
		this.ensureEngaged(contentWrapper, state);
		if (!state.engaged) return;
		let newScale = state.scale * factor;
		newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

		const container = contentWrapper.parentElement;
		if (container) {
			const rect = container.getBoundingClientRect();
			const centerX = rect.width / 2;
			const centerY = rect.height / 2;
			const scaleRatio = newScale / state.scale;

			state.translateX = centerX - (centerX - state.translateX) * scaleRatio;
			state.translateY = centerY - (centerY - state.translateY) * scaleRatio;
		}

		state.scale = newScale;
		this.updateTransform(contentWrapper, state);
	}

	private resetZoom(contentWrapper: HTMLElement, state: ZoomState) {
		this.disengage(contentWrapper, state);
	}

	private updateTransform(contentWrapper: HTMLElement, state: ZoomState) {
		contentWrapper.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
		if (state.scaleIndicator) {
			state.scaleIndicator.textContent = `${Math.round(state.scale * 100)}%`;
		}
	}

	destroy() {
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = undefined;
		}
		this.zoomStates.clear();
	}
}
