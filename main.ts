import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';

interface MermaidZoomSettings {
	requireModifierForZoom: boolean;
	showControlsOnHover: boolean;
	// Container appearance (live-editable)
	containerPadding: string;
	containerMargin: string;
	containerBackground: string;
	containerBorderRadius: string;
	containerBorder: string;
	containerBorderHover: string;
	// Advanced raw CSS
	customContainerCSS: string;
	customMermaidCSS: string;
	customThemeCSS: string;   // raw CSS, injected verbatim (user provides selectors)
}

const DEFAULT_SETTINGS: MermaidZoomSettings = {
	requireModifierForZoom: true,
	showControlsOnHover: true,
	containerPadding: '1em',
	containerMargin: '1em',
	containerBackground: 'var(--background-secondary)',
	containerBorderRadius: '8px',
	containerBorder: '1px solid var(--background-modifier-border)',
	containerBorderHover: '',
	customContainerCSS: '',
	customMermaidCSS: '',
	customThemeCSS: ''
};

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
	// Original SVG dimensions (saved once)
	svgOriginalWidth: number;
	svgOriginalHeight: number;
	// True once the user has dragged the bottom edge to set a manual height.
	// While false, the container height auto-fits the diagram (fit-to-content).
	userResizedHeight: boolean;
}

export default class MermaidZoomPlugin extends Plugin {
	settings: MermaidZoomSettings = DEFAULT_SETTINGS;
	private readonly zoomStates = new Map<HTMLElement, ZoomState>();
	private readonly defaultMinScale = 0.1;
	private readonly defaultMaxScale = 5;
	private readonly defaultScale = 1;
	private mutationObserver?: MutationObserver;
	private resizeObserver?: ResizeObserver;
	private processedElements = new WeakSet<SVGSVGElement>();
	private pendingElements = new Set<SVGSVGElement>();
	private customStyleEl?: HTMLStyleElement;

	async onload() {
		console.debug('Loading Mermaid Zoom plugin');

		await this.loadSettings();
		this.addSettingTab(new MermaidZoomSettingTab(this.app, this));

		// Inject custom CSS
		this.injectCustomCSS();

		// Set up observers
		this.setupMutationObserver();
		this.setupResizeObserver();

		// Initial processing of existing content
		this.app.workspace.onLayoutReady(() => {
			this.processAllMermaidDiagrams();
		});

		// Re-process when layout changes
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.processAllMermaidDiagrams();
		}));

		// Also listen for active leaf changes
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.processAllMermaidDiagrams();
		}));

		// Listen for file open
		this.registerEvent(this.app.workspace.on('file-open', () => {
			// Delay to allow mermaid to render
			setTimeout(() => this.processAllMermaidDiagrams(), 200);
		}));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.injectCustomCSS();
		// Re-fit existing diagrams after the new CSS (e.g. padding) is applied.
		requestAnimationFrame(() => this.refitAll());
	}

	private refitAll() {
		for (const [contentWrapper, state] of this.zoomStates) {
			this.fitToContainer(state.container, contentWrapper, state.svg, state);
		}
	}

	private injectCustomCSS() {
		// Remove existing custom style element
		if (this.customStyleEl) {
			this.customStyleEl.remove();
			this.customStyleEl = undefined;
		}

		const parts: string[] = [];

		// Base container appearance (from settings). First so that the advanced
		// custom-CSS fields below can still override these defaults.
		// padding-bottom adds room for the controls bar on top of the chosen padding.
		parts.push(`
.mermaid-zoom-container {
	background: ${this.settings.containerBackground};
	border: ${this.settings.containerBorder};
	border-radius: ${this.settings.containerBorderRadius};
	margin: ${this.settings.containerMargin} 0;
	padding: ${this.settings.containerPadding};
	padding-bottom: calc(${this.settings.containerPadding} + 1.5em);
	transition: border-color 0.15s ease, border 0.15s ease;
}
		`);

		// Border on hover (optional)
		if (this.settings.containerBorderHover.trim()) {
			parts.push(`.mermaid-zoom-container:hover { border: ${this.settings.containerBorderHover}; }`);
		}

		// Hover-only controls
		if (this.settings.showControlsOnHover) {
			parts.push(`
.mermaid-zoom-container .mermaid-zoom-controls {
	opacity: 0;
	transition: opacity 0.2s ease;
	pointer-events: none;
}
.mermaid-zoom-container:hover .mermaid-zoom-controls {
	opacity: 1;
	pointer-events: auto;
}
			`);
		}

		// Custom container CSS
		if (this.settings.customContainerCSS.trim()) {
			parts.push(`.mermaid-zoom-container { ${this.settings.customContainerCSS} }`);
		}

		// Custom mermaid CSS
		if (this.settings.customMermaidCSS.trim()) {
			parts.push(`.mermaid-zoom-container .mermaid { ${this.settings.customMermaidCSS} }`);
			parts.push(`.mermaid-zoom-container svg { ${this.settings.customMermaidCSS} }`);
		}

		// Full custom theme CSS (verbatim, user provides own selectors). Last on purpose:
		// keeps malformed theme CSS from breaking the functional blocks above.
		if (this.settings.customThemeCSS.trim()) {
			parts.push(this.settings.customThemeCSS);
		}

		if (parts.length > 0) {
			this.customStyleEl = document.createElement('style');
			this.customStyleEl.id = 'mermaid-zoom-custom-styles';
			this.customStyleEl.textContent = parts.join('\n');
			document.head.appendChild(this.customStyleEl);
		}
	}

	private setupResizeObserver() {
		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const container = entry.target as HTMLElement;
				const contentWrapper = container.querySelector('.mermaid-zoom-content') as HTMLElement;
				if (!contentWrapper) continue;
				const state = this.zoomStates.get(contentWrapper);
				if (state) {
					this.fitToContainer(container, contentWrapper, state.svg, state);
				}
			}
		});
	}

	private setupMutationObserver() {
		this.mutationObserver = new MutationObserver((mutations) => {
			for (const mutation of Array.from(mutations)) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (node instanceof HTMLElement || node instanceof SVGElement) {
						this.processPotentialMermaidElement(node);
					}
				}
			}
		});

		// Start observing the document body
		this.mutationObserver.observe(document.body, {
			childList: true,
			subtree: true
		});
	}

	private processPotentialMermaidElement(element: Element) {
		// Check if this element is or contains a mermaid svg
		// Obsidian structure: <div class="mermaid"><svg id="mermaid-xxx">...</svg></div>
		const mermaidSvgs: SVGSVGElement[] = [];

		if (element instanceof HTMLElement) {
			// Find SVGs inside .mermaid containers or SVGs with mermaid id
			const svgs = Array.from(element.querySelectorAll('.mermaid svg, svg[id^="mermaid-"]'));
			mermaidSvgs.push(...svgs as SVGSVGElement[]);

			// Also check if element itself is a mermaid container
			if (element.classList.contains('mermaid')) {
				const svg = element.querySelector('svg');
				if (svg) mermaidSvgs.push(svg);
			}
		} else if (element instanceof SVGSVGElement) {
			if (element.matches('svg[id^="mermaid-"]') || element.closest('.mermaid')) {
				mermaidSvgs.push(element);
			}
		}

		for (const svg of mermaidSvgs) {
			this.scheduleWrapMermaid(svg);
		}
	}

	private hasZoomContainer(svg: SVGSVGElement): boolean {
		// Check if SVG or its .mermaid parent is already inside a zoom container
		const mermaidContainer = svg.closest('.mermaid');
		const parent = mermaidContainer?.parentElement || svg.parentElement;
		return parent?.hasClass('mermaid-zoom-content') ?? false;
	}

	private processAllMermaidDiagrams() {
		// Find all mermaid SVGs - Obsidian uses .mermaid container with SVG inside
		const mermaidSvgs = document.querySelectorAll('.mermaid svg, svg[id^="mermaid-"]');
		for (const mermaidSvg of Array.from(mermaidSvgs) as SVGSVGElement[]) {
			this.scheduleWrapMermaid(mermaidSvg);
		}
	}

	private scheduleWrapMermaid(svg: SVGSVGElement) {
		if (this.processedElements.has(svg) || this.pendingElements.has(svg) || this.hasZoomContainer(svg)) {
			return;
		}

		this.pendingElements.add(svg);

		// Mermaid may still be mutating the SVG when MutationObserver sees it.
		// A short delay avoids changing the parent layout while subgraph bounds
		// are still being computed.
		window.setTimeout(() => {
			requestAnimationFrame(() => {
				this.pendingElements.delete(svg);

				if (!svg.isConnected || this.processedElements.has(svg) || this.hasZoomContainer(svg)) {
					return;
				}

				if (this.wrapMermaidWithZoom(svg)) {
					this.processedElements.add(svg);
				}
			});
		}, 50);
	}

	wrapMermaidWithZoom(svg: SVGSVGElement): boolean {
		if (!svg.parentElement) return false;

		// Find the original .mermaid container
		const mermaidContainer = svg.closest('.mermaid') as HTMLElement;
		const targetParent = mermaidContainer?.parentElement || svg.parentElement;
		const targetElement = mermaidContainer || svg;

		if (!targetParent) return false;

		// Get SVG dimensions for initial container sizing
		const svgSize = this.getSvgIntrinsicSize(svg);
		this.lockSvgDisplaySize(svg, svgSize);
		const initialSvgHeight = svgSize.height || 200;

		// Rough initial height; fitToContainer() corrects it to fit-to-content
		// synchronously right after the container is inserted.
		const containerHeight = initialSvgHeight + 60;

		// Create zoom container. Only functional/layout styles are inline here;
		// appearance (padding, margin, background, border) comes from the
		// injected .mermaid-zoom-container rule so it stays live-editable.
		const container = createDiv('mermaid-zoom-container');
		container.style.cssText = `
			position: relative;
			overflow: hidden;
			width: 100%;
			height: ${containerHeight}px;
			min-width: 150px;
			min-height: 100px;
			box-sizing: border-box;
		`;

		// Create content wrapper for transformations
		const contentWrapper = container.createDiv('mermaid-zoom-content');
		contentWrapper.style.cssText = `
			transform-origin: 0 0;
			transition: transform 0.1s ease-out;
			width: fit-content;
		`;

		// Insert container and move content inside
		targetParent.insertBefore(container, targetElement);
		contentWrapper.appendChild(targetElement);

		// Use intrinsic SVG dimensions, not the current CSS box. Mermaid SVGs
		// often render with width="100%"; measuring that CSS width makes wide
		// notes look like the diagram itself is thousands of pixels wide.
		const svgOriginalWidth = svgSize.width;
		const svgOriginalHeight = svgSize.height;

		// Initialize zoom state
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
			svgOriginalWidth: svgOriginalWidth,
			svgOriginalHeight: svgOriginalHeight,
			userResizedHeight: false
		};
		this.zoomStates.set(contentWrapper, state);

		// Create controls (includes resize handle)
		this.createControls(container, contentWrapper, state);

		// Add mouse wheel zoom
		this.addWheelZoom(container, contentWrapper, state);

		// Add drag to pan
		this.addDragPan(container, contentWrapper, state);

		// Add touch gesture support
		this.addTouchGestures(container, contentWrapper, state);

		// Fit SVG to container initially
		this.fitToContainer(container, contentWrapper, svg, state);

		// Re-fit on container resize
		this.resizeObserver?.observe(container);
		return true;
	}

	private getSvgIntrinsicSize(svg: SVGSVGElement): { width: number; height: number } {
		const viewBox = svg.viewBox?.baseVal;
		if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
			return { width: viewBox.width, height: viewBox.height };
		}

		const attrWidth = this.parseSvgLength(svg.getAttribute('width'));
		const attrHeight = this.parseSvgLength(svg.getAttribute('height'));
		if (attrWidth && attrHeight) {
			return { width: attrWidth, height: attrHeight };
		}

		try {
			const bbox = svg.getBBox();
			if (bbox.width > 0 && bbox.height > 0) {
				return { width: bbox.width, height: bbox.height };
			}
		} catch {
			// getBBox can throw for detached or not-yet-rendered SVGs.
		}

		const rect = svg.getBoundingClientRect();
		return {
			width: rect.width || svg.clientWidth || 300,
			height: rect.height || svg.clientHeight || 200
		};
	}

	private parseSvgLength(value: string | null): number | undefined {
		if (!value) return undefined;
		const trimmed = value.trim();
		if (!trimmed || trimmed.endsWith('%')) return undefined;

		const match = trimmed.match(/^([0-9]*\.?[0-9]+)/);
		if (!match) return undefined;

		const parsed = Number(match[1]);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}

	private lockSvgDisplaySize(svg: SVGSVGElement, size: { width: number; height: number }) {
		svg.style.width = `${size.width}px`;
		svg.style.height = `${size.height}px`;
		svg.style.maxWidth = 'none';
		svg.style.maxHeight = 'none';
		svg.style.overflow = 'visible';
	}

	// Ideal container height (border-box) so the diagram fits the full width
	// with no extra vertical slack. Clamped to min-height.
	private idealContentHeight(container: HTMLElement, state: ZoomState): number {
		const cs = getComputedStyle(container);
		const padLeft = parseFloat(cs.paddingLeft) || 0;
		const padRight = parseFloat(cs.paddingRight) || 0;
		const padTop = parseFloat(cs.paddingTop) || 0;
		const padBottom = parseFloat(cs.paddingBottom) || 0;
		const borderTop = parseFloat(cs.borderTopWidth) || 0;
		const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
		const minHeight = parseFloat(cs.minHeight) || 0;

		const availableWidth = Math.max(container.clientWidth - padLeft - padRight, 0);
		const fitScale = Math.min(availableWidth / state.svgOriginalWidth, state.maxScale);
		const contentHeight = state.svgOriginalHeight * fitScale;
		return Math.max(contentHeight + padTop + padBottom + borderTop + borderBottom, minHeight);
	}

	// Auto-fit the container height to the diagram, unless the user has set a
	// manual height by dragging the bottom edge. The >1px guard keeps this from
	// looping with the ResizeObserver (it converges after one pass).
	private applyFitHeight(container: HTMLElement, state: ZoomState) {
		if (state.userResizedHeight) return;
		const ideal = this.idealContentHeight(container, state);
		if (Math.abs(container.offsetHeight - ideal) > 1) {
			container.style.height = `${ideal}px`;
		}
	}

	private fitToContainer(container: HTMLElement, contentWrapper: HTMLElement, svg: SVGSVGElement, state: ZoomState) {
		// Auto-size the height to the content first (no-op if manually resized).
		this.applyFitHeight(container, state);

		// Get available space using the real computed padding, so a custom
		// container padding from settings doesn't break the fit calculation.
		const cs = getComputedStyle(container);
		const padLeft = parseFloat(cs.paddingLeft) || 0;
		const padRight = parseFloat(cs.paddingRight) || 0;
		const padTop = parseFloat(cs.paddingTop) || 0;
		const padBottom = parseFloat(cs.paddingBottom) || 0;
		const availableWidth = Math.max(container.clientWidth - padLeft - padRight, 0);
		const availableHeight = Math.max(container.clientHeight - padTop - padBottom, 0);

		// Use saved original SVG dimensions
		const svgWidth = state.svgOriginalWidth;
		const svgHeight = state.svgOriginalHeight;

		// Calculate scale to fit
		const scaleX = availableWidth / svgWidth;
		const scaleY = availableHeight / svgHeight;
		const fitScale = Math.min(scaleX, scaleY, state.maxScale);

		// Center the SVG within the available area
		const scaledWidth = svgWidth * fitScale;
		const scaledHeight = svgHeight * fitScale;
		const centerX = (availableWidth - scaledWidth) / 2;
		const centerY = (availableHeight - scaledHeight) / 2;

		// Apply the scale and center
		state.scale = fitScale;
		state.translateX = centerX;
		state.translateY = Math.max(0, centerY);
		this.updateTransform(contentWrapper, state);
	}

	private openFullscreenModal(state: ZoomState) {
		// Create modal overlay
		const modal = document.createElement('div');
		modal.className = 'mermaid-zoom-modal';
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

		// Create header with close button
		const header = document.createElement('div');
		header.className = 'mermaid-zoom-modal-header';
		header.style.cssText = `
			display: flex;
			justify-content: flex-end;
			padding: 10px 15px;
			background: var(--background-secondary);
			border-bottom: 1px solid var(--background-modifier-border);
		`;

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.className = 'mermaid-zoom-modal-close';
		closeBtn.textContent = '✕';
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

		// Create content area
		const content = document.createElement('div');
		content.className = 'mermaid-zoom-modal-content';
		content.style.cssText = `
			flex: 1;
			overflow: hidden;
			position: relative;
			display: flex;
			align-items: center;
			justify-content: center;
		`;

		// Create zoom container inside modal
		const modalZoomContainer = document.createElement('div');
		modalZoomContainer.className = 'mermaid-zoom-modal-zoom-container';
		modalZoomContainer.style.cssText = `
			width: 100%;
			height: 100%;
			overflow: hidden;
			position: relative;
		`;

		// Create content wrapper for transformations
		const modalContentWrapper = document.createElement('div');
		modalContentWrapper.className = 'mermaid-zoom-modal-wrapper';
		modalContentWrapper.style.cssText = `
			transform-origin: 0 0;
			transition: transform 0.1s ease-out;
			width: fit-content;
			position: absolute;
		`;

		// Clone the SVG
		const svgClone = state.svg.cloneNode(true) as SVGSVGElement;
		modalContentWrapper.appendChild(svgClone);
		modalZoomContainer.appendChild(modalContentWrapper);
		content.appendChild(modalZoomContainer);

		// Create modal controls
		const controls = document.createElement('div');
		controls.className = 'mermaid-zoom-modal-controls';
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

		// Modal zoom state
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
			svgOriginalWidth: state.svgOriginalWidth,
			svgOriginalHeight: state.svgOriginalHeight,
			userResizedHeight: true   // modal manages its own size; skip auto-fit-height
		};

		// Add zoom buttons
		const zoomInBtn = document.createElement('button');
		zoomInBtn.textContent = '+';
		this.styleButton(zoomInBtn);
		zoomInBtn.addEventListener('click', () => this.zoom(modalContentWrapper, modalState, 1.2));

		const zoomOutBtn = document.createElement('button');
		zoomOutBtn.textContent = '-';
		this.styleButton(zoomOutBtn);
		zoomOutBtn.addEventListener('click', () => this.zoom(modalContentWrapper, modalState, 0.8));

		const resetBtn = document.createElement('button');
		resetBtn.textContent = '⟲';
		this.styleButton(resetBtn);
		resetBtn.addEventListener('click', () => {
			this.fitToContainerModal(modalZoomContainer, modalContentWrapper, modalState);
		});

		// Scale indicator
		const scaleIndicator = document.createElement('span');
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

		// Close modal function
		const closeModal = () => {
			modal.remove();
			document.removeEventListener('keydown', handleKeydown);
		};

		// Handle ESC key
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				closeModal();
			}
		};
		document.addEventListener('keydown', handleKeydown);

		// Close button click
		closeBtn.addEventListener('click', closeModal);

		// Add modal to document
		document.body.appendChild(modal);

		// Add zoom/pan interactions to modal (no modifier required in modal)
		this.addWheelZoom(modalZoomContainer, modalContentWrapper, modalState, false);
		this.addDragPan(modalZoomContainer, modalContentWrapper, modalState);
		this.addTouchGestures(modalZoomContainer, modalContentWrapper, modalState);

		// Fit to container after modal is visible
		requestAnimationFrame(() => {
			this.fitToContainerModal(modalZoomContainer, modalContentWrapper, modalState);
		});
	}

	private fitToContainerModal(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState) {
		// Get available space
		const padding = 40;
		const availableWidth = container.clientWidth - padding * 2;
		const availableHeight = container.clientHeight - padding * 2;

		// Use saved original SVG dimensions
		const svgWidth = state.svgOriginalWidth;
		const svgHeight = state.svgOriginalHeight;

		// Calculate scale to fit
		const scaleX = availableWidth / svgWidth;
		const scaleY = availableHeight / svgHeight;
		const fitScale = Math.min(scaleX, scaleY, 2); // Allow up to 200% in modal

		// Center the SVG
		const scaledWidth = svgWidth * fitScale;
		const scaledHeight = svgHeight * fitScale;
		const centerX = (container.clientWidth - scaledWidth) / 2;
		const centerY = (container.clientHeight - scaledHeight) / 2;

		// Apply the scale and center
		state.scale = fitScale;
		state.translateX = centerX;
		state.translateY = centerY;
		this.updateTransform(contentWrapper, state);
	}

	private createControls(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState) {
		const controls = container.createDiv('mermaid-zoom-controls');
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

		// Zoom in button
		const zoomInBtn = controls.createEl('button', {
			text: '+',
			cls: 'mermaid-zoom-btn'
		});
		this.styleButton(zoomInBtn);
		zoomInBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.zoom(contentWrapper, state, 1.2);
		});

		// Zoom out button
		const zoomOutBtn = controls.createEl('button', {
			text: '-',
			cls: 'mermaid-zoom-btn'
		});
		this.styleButton(zoomOutBtn);
		zoomOutBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.zoom(contentWrapper, state, 0.8);
		});

		// Reset button
		const resetBtn = controls.createEl('button', {
			text: '⟲',
			cls: 'mermaid-zoom-btn'
		});
		this.styleButton(resetBtn);
		resetBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.resetZoom(contentWrapper, state);
		});

		// Scale indicator
		const scaleIndicator = controls.createEl('span', {
			cls: 'mermaid-zoom-scale'
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
		this.updateTransform(contentWrapper, state);

		// Fullscreen toggle button
		const fullscreenBtn = controls.createEl('button', {
			cls: 'mermaid-zoom-btn mermaid-fullscreen-btn'
		});

		// Create SVG icon
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('width', '24');
		svg.setAttribute('height', '24');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');

		const polyline1 = document.createElementNS(svgNS, 'polyline');
		polyline1.setAttribute('points', '1,10 1,15 6,15');
		svg.appendChild(polyline1);

		const polyline2 = document.createElementNS(svgNS, 'polyline');
		polyline2.setAttribute('points', '15,10 15,15 10,15');
		svg.appendChild(polyline2);

		const polyline3 = document.createElementNS(svgNS, 'polyline');
		polyline3.setAttribute('points', '1,6 1,1 6,1');
		svg.appendChild(polyline3);

		const polyline4 = document.createElementNS(svgNS, 'polyline');
		polyline4.setAttribute('points', '15,6 15,1 10,1');
		svg.appendChild(polyline4);

		fullscreenBtn.appendChild(svg);
		this.styleButton(fullscreenBtn);
		fullscreenBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openFullscreenModal(state);
		});

		// Add the bottom-edge resize handle (vertical only)
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

	private addResizeHandle(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState) {
		// Single bottom-edge handle: the container is only vertically resizable
		// (drag down to make it taller). Width stays responsive (100%).
		const handle = container.createDiv('mermaid-resize-bottom');
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
			document.body.addClass('mermaid-zoom-resizing-ns');
		};

		const onMouseMove = (e: MouseEvent) => {
			if (!isResizing) return;
			e.preventDefault();
			const newHeight = Math.max(100, startHeight + (e.clientY - startY));
			// Mark as manual so fit-to-content stops overriding the height,
			// then re-center the diagram within the new height.
			state.userResizedHeight = true;
			container.style.height = `${newHeight}px`;
			this.fitToContainer(container, contentWrapper, state.svg, state);
		};

		const onMouseUp = () => {
			if (!isResizing) return;
			isResizing = false;
			document.body.removeClass('mermaid-zoom-resizing-ns');
		};

		handle.addEventListener('mousedown', onMouseDown);
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
	}

	private addWheelZoom(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState, respectModifier = true) {
		container.addEventListener('wheel', (e) => {
			// Chromium/Electron reports trackpad pinch-zoom as a wheel event
			// with ctrlKey === true. Treat that as an always-on zoom gesture.
			const isPinch = e.ctrlKey;
			const hasModifier = e.ctrlKey || e.metaKey;

			// Mouse-wheel scroll without a modifier: let the note scroll
			// normally (when the setting requires a modifier). Pinch always zooms.
			if (respectModifier && this.settings.requireModifierForZoom && !hasModifier) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			const rect = container.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			// Smooth, proportional zoom for both mouse wheel and trackpad pinch.
			// Pinch deltas are small floats; wheel deltas are larger steps.
			const intensity = isPinch ? 0.01 : 0.0015;
			const oldScale = state.scale;
			let newScale = oldScale * Math.exp(-e.deltaY * intensity);
			newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

			if (newScale !== oldScale) {
				// Adjust translation to zoom toward cursor position
				const scaleRatio = newScale / oldScale;
				state.translateX = mouseX - (mouseX - state.translateX) * scaleRatio;
				state.translateY = mouseY - (mouseY - state.translateY) * scaleRatio;
				state.scale = newScale;

				this.updateTransform(contentWrapper, state);
			}
		}, { passive: false });
	}

	private addDragPan(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState) {
		container.addEventListener('mousedown', (e) => {
			if (e.button === 0) { // Left mouse button
				// Prevent text/SVG selection from hijacking the drag
				e.preventDefault();
				state.isDragging = true;
				state.startX = e.clientX - state.translateX;
				state.startY = e.clientY - state.translateY;
				container.addClass('is-dragging');
			}
		});

		document.addEventListener('mousemove', (e) => {
			if (state.isDragging) {
				e.preventDefault();
				state.translateX = e.clientX - state.startX;
				state.translateY = e.clientY - state.startY;
				this.updateTransform(contentWrapper, state);
			}
		});

		document.addEventListener('mouseup', () => {
			if (state.isDragging) {
				state.isDragging = false;
				container.removeClass('is-dragging');
			}
		});
	}

	private addTouchGestures(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState) {
		let initialDistance = 0;
		let initialScale = 1;

		// Non-passive: touchmove calls preventDefault() to own pinch/drag gestures,
		// so the paired touchstart must also opt out of passive to silence the
		// browser's scroll-blocking violation warning.
		container.addEventListener('touchstart', (e) => {
			if (e.touches.length === 2) {
				// Pinch to zoom
				const touch1 = e.touches[0];
				const touch2 = e.touches[1];
				initialDistance = Math.hypot(
					touch2.clientX - touch1.clientX,
					touch2.clientY - touch1.clientY
				);
				initialScale = state.scale;
			} else if (e.touches.length === 1) {
				// Single touch drag
				state.isDragging = true;
				state.startX = e.touches[0].clientX - state.translateX;
				state.startY = e.touches[0].clientY - state.translateY;
			}
		}, { passive: false });

		container.addEventListener('touchmove', (e) => {
			e.preventDefault();

			if (e.touches.length === 2) {
				// Pinch to zoom
				const touch1 = e.touches[0];
				const touch2 = e.touches[1];
				const currentDistance = Math.hypot(
					touch2.clientX - touch1.clientX,
					touch2.clientY - touch1.clientY
				);

				const scaleRatio = currentDistance / initialDistance;
				let newScale = initialScale * scaleRatio;
				newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

				state.scale = newScale;
				this.updateTransform(contentWrapper, state);
			} else if (e.touches.length === 1 && state.isDragging) {
				// Single touch drag
				state.translateX = e.touches[0].clientX - state.startX;
				state.translateY = e.touches[0].clientY - state.startY;
				this.updateTransform(contentWrapper, state);
			}
		}, { passive: false });

		container.addEventListener('touchend', () => {
			state.isDragging = false;
		});
	}

	private zoom(contentWrapper: HTMLElement, state: ZoomState, factor: number) {
		let newScale = state.scale * factor;
		newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

		// Center the zoom
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
		// Reset also drops any manual height back to fit-to-content
		state.userResizedHeight = false;
		this.fitToContainer(state.container, contentWrapper, state.svg, state);
	}

	private updateTransform(contentWrapper: HTMLElement, state: ZoomState) {
		contentWrapper.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;

		// Update scale indicator
		if (state.scaleIndicator) {
			state.scaleIndicator.textContent = `${Math.round(state.scale * 100)}%`;
		}
	}

	onunload() {
		console.debug('Unloading Mermaid Zoom plugin');

		// Disconnect observers
		if (this.mutationObserver) {
			this.mutationObserver.disconnect();
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}

		// Remove custom styles
		if (this.customStyleEl) {
			this.customStyleEl.remove();
		}

		this.zoomStates.clear();
		this.pendingElements.clear();
		this.processedElements = new WeakSet();
	}
}

class MermaidZoomSettingTab extends PluginSettingTab {
	plugin: MermaidZoomPlugin;

	constructor(app: App, plugin: MermaidZoomPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Behavior ---
		new Setting(containerEl)
			.setName('Require Ctrl/Cmd for scroll zoom')
			.setDesc('When enabled, scrolling over a diagram only zooms while holding Ctrl (Windows/Linux) or Cmd (Mac). Prevents accidental zoom while scrolling the note.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.requireModifierForZoom)
				.onChange(async (value) => {
					this.plugin.settings.requireModifierForZoom = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show controls on hover only')
			.setDesc('Hide the zoom/reset/fullscreen controls until you hover over the diagram.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showControlsOnHover)
				.onChange(async (value) => {
					this.plugin.settings.showControlsOnHover = value;
					await this.plugin.saveSettings();
				}));

		// --- Appearance ---
		containerEl.createEl('h3', { text: 'Appearance' });

		new Setting(containerEl)
			.setName('Inner padding')
			.setDesc('Space between the container edge and the diagram. Single CSS value (e.g. 1em, 12px). Room for the controls bar is added automatically.')
			.addText(text => text
				.setPlaceholder('1em')
				.setValue(this.plugin.settings.containerPadding)
				.onChange(async (value) => {
					this.plugin.settings.containerPadding = value || DEFAULT_SETTINGS.containerPadding;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Vertical margin')
			.setDesc('Space above and below the container. Single CSS value (e.g. 1em, 16px).')
			.addText(text => text
				.setPlaceholder('1em')
				.setValue(this.plugin.settings.containerMargin)
				.onChange(async (value) => {
					this.plugin.settings.containerMargin = value || DEFAULT_SETTINGS.containerMargin;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Background')
			.setDesc('Container background. Any CSS color or variable (e.g. var(--background-secondary), transparent, #1e1e1e).')
			.addText(text => text
				.setPlaceholder('var(--background-secondary)')
				.setValue(this.plugin.settings.containerBackground)
				.onChange(async (value) => {
					this.plugin.settings.containerBackground = value || DEFAULT_SETTINGS.containerBackground;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Border radius')
			.setDesc('Corner rounding of the container. Single CSS value (e.g. 8px, 0).')
			.addText(text => text
				.setPlaceholder('8px')
				.setValue(this.plugin.settings.containerBorderRadius)
				.onChange(async (value) => {
					this.plugin.settings.containerBorderRadius = value || DEFAULT_SETTINGS.containerBorderRadius;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Border')
			.setDesc('Container border. Full CSS border shorthand (e.g. 1px solid var(--background-modifier-border), none).')
			.addText(text => text
				.setPlaceholder('1px solid var(--background-modifier-border)')
				.setValue(this.plugin.settings.containerBorder)
				.onChange(async (value) => {
					this.plugin.settings.containerBorder = value || DEFAULT_SETTINGS.containerBorder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Border on hover')
			.setDesc('Optional border shown only while hovering the diagram. Leave empty to disable. Full CSS border shorthand (e.g. 1px solid var(--interactive-accent)).')
			.addText(text => text
				.setPlaceholder('1px solid var(--interactive-accent)')
				.setValue(this.plugin.settings.containerBorderHover)
				.onChange(async (value) => {
					this.plugin.settings.containerBorderHover = value;
					await this.plugin.saveSettings();
				}));

		// --- Custom CSS ---
		containerEl.createEl('h3', { text: 'Custom CSS' });

		new Setting(containerEl)
			.setName('Container CSS')
			.setDesc('Custom CSS properties applied to the zoom container (e.g. background, border-radius, border).')
			.addTextArea(text => {
				text.inputEl.style.width = '100%';
				text.inputEl.style.height = '100px';
				text.inputEl.style.fontFamily = 'var(--font-monospace)';
				text.inputEl.style.fontSize = '12px';
				text
					.setPlaceholder('background: transparent;\nborder: none;\nborder-radius: 0;')
					.setValue(this.plugin.settings.customContainerCSS)
					.onChange(async (value) => {
						this.plugin.settings.customContainerCSS = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Mermaid diagram CSS')
			.setDesc('Custom CSS properties applied to the Mermaid SVG inside the container (e.g. font-size, color overrides).')
			.addTextArea(text => {
				text.inputEl.style.width = '100%';
				text.inputEl.style.height = '100px';
				text.inputEl.style.fontFamily = 'var(--font-monospace)';
				text.inputEl.style.fontSize = '12px';
				text
					.setPlaceholder('font-size: 14px;')
					.setValue(this.plugin.settings.customMermaidCSS)
					.onChange(async (value) => {
						this.plugin.settings.customMermaidCSS = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Theme CSS (advanced)')
			.setDesc('Full CSS rules, injected verbatim. Write your own selectors and scope them to .mermaid-zoom-container / svg.flowchart so only zoomed diagrams are affected. Use !important to override Mermaid inline styles. Lets you apply and freely edit a complete diagram theme (nodes, edges, decision shapes, labels) without a global CSS snippet.')
			.addTextArea(text => {
				text.inputEl.style.width = '100%';
				text.inputEl.style.height = '220px';
				text.inputEl.style.fontFamily = 'var(--font-monospace)';
				text.inputEl.style.fontSize = '12px';
				text
					.setPlaceholder('.mermaid-zoom-container svg.flowchart .node rect {\n  fill: #fff !important;\n  stroke: #004994 !important;\n}')
					.setValue(this.plugin.settings.customThemeCSS)
					.onChange(async (value) => {
						this.plugin.settings.customThemeCSS = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
