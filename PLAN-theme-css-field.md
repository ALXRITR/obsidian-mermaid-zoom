# Implementierungsplan: Roh-CSS-Feld ("Theme CSS") für eigenes Diagramm-Theme

## Ziel

Das Plugin soll es erlauben, ein **vollständiges, eigenes Mermaid-Theme einzusetzen und frei anzupassen** - inklusive Node-, Kanten- und Entscheidungs-Styling. Das Theme soll **nicht hardcoded** sein, sondern in den Plugin-Settings (`data.json`) liegen und jederzeit editierbar bleiben.

### Warum ein neues Feld nötig ist

Die zwei bestehenden Felder wickeln ihren Inhalt jeweils in **genau einen Selektor** (`injectCustomCSS()`, aktuell Z. 114-122):

```ts
parts.push(`.mermaid-zoom-container { ${this.settings.customContainerCSS} }`);
parts.push(`.mermaid-zoom-container .mermaid { ${this.settings.customMermaidCSS} }`);
parts.push(`.mermaid-zoom-container svg { ${this.settings.customMermaidCSS} }`);
```

Damit lassen sich nur **flache Properties** am Container bzw. SVG-Root setzen. Das eigentliche Theme braucht aber **Kind-Selektoren** (`.node rect`, `.node polygon`, `.edgePath .path`, `.node.primary` ...). Lösung: ein drittes Feld, dessen Inhalt **verbatim** (ohne Selektor-Wrapper) in den `<style>`-Block geschrieben wird. Der Nutzer bringt seine eigenen Selektoren mit.

Die zwei bestehenden Felder bleiben unverändert erhalten (Rückwärtskompatibilität / Schnell-Tweaks).

---

## Code-Änderungen in `main.ts`

### 1. Settings-Interface erweitern (Z. 3-8)

```ts
interface MermaidZoomSettings {
	requireModifierForZoom: boolean;
	showControlsOnHover: boolean;
	customContainerCSS: string;
	customMermaidCSS: string;
	customThemeCSS: string;   // NEU: rohes CSS, wird unverpackt injiziert
}
```

### 2. DEFAULT_SETTINGS ergänzen (Z. 10-15)

```ts
const DEFAULT_SETTINGS: MermaidZoomSettings = {
	requireModifierForZoom: true,
	showControlsOnHover: true,
	customContainerCSS: '',
	customMermaidCSS: '',
	customThemeCSS: ''        // NEU
};
```

### 3. `injectCustomCSS()` erweitern

`customThemeCSS` wird **als letzter Teil** und **ohne Selektor-Wrapper** angehängt. "Als letzter" bewusst gewählt:

- **Fehler-Isolation:** Ein fehlerhaftes Roh-CSS (z.B. unbalancierte `{}`) kann so nicht die funktionalen Hover-/Container-Regeln zerstören, die davor stehen.
- **Vorrang:** Bei gleicher Spezifität gewinnt das spätere - das selbst-gescopte Theme schlägt also die generischen Flach-Felder. (Empfehlung an den Nutzer: Theme komplett ins neue Feld, die zwei Flach-Felder leer lassen.)

Direkt vor dem `if (parts.length > 0)`-Block (nach aktueller Z. 122) einfügen:

```ts
		// Full custom theme CSS (verbatim, user provides own selectors). Last on purpose:
		// keeps malformed theme CSS from breaking the functional blocks above.
		if (this.settings.customThemeCSS.trim()) {
			parts.push(this.settings.customThemeCSS);
		}
```

### 4. SettingTab-UI ergänzen

Nach dem "Mermaid diagram CSS"-Setting (nach aktueller Z. 1020), vor dem schließenden `}` der `display()`-Methode:

```ts
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
```

`saveSettings()` ruft bereits `injectCustomCSS()` auf (Z. 86) - Live-Reload des Themes ist damit out of the box gegeben.

---

## Build & Verifikation

```bash
npm run build      # tsc Type-Check + esbuild -> main.js
```

1. Plugin in einem Test-Vault neu laden (Obsidian: Plugin aus/an, oder Cmd+R).
2. Settings → Mermaid Zoom → "Theme CSS (advanced)" → das UK-NRW-CSS (unten) einfügen.
3. Eine Note mit Flowchart öffnen (Default-Node, Entscheidungs-Raute `{...}`, ein `:::primary`-Node).
4. Prüfen: weiße Karten + Navy-Kontur + Card-Shadow, rote Rauten, Navy-gefüllter Primary-Node, heller Container in **Dark UND Light Mode**.
5. Zoom/Pan testen (Theme darf die Transform-Logik nicht stören - reines CSS, tut es nicht).

---

## Fertiges UK-NRW "Portal Light"-Theme zum Einfügen

In das neue Feld "Theme CSS (advanced)" einfügen. Tokens stehen oben gebündelt - Farben/Radius dort zentral anpassen (`var(--uknrw-*)` vererbt an alle Regeln).

```css
/* === UK NRW "Portal Light" Theme fuer mermaid-zoom === */
/* Frei editierbar. Tokens hier zentral anpassen: */
.mermaid-zoom-container {
  --uknrw-navy: #004994;
  --uknrw-white: #ffffff;
  --uknrw-red: #da5c5f;
  --uknrw-red-tint: #fbeaea;
  --uknrw-red-tint-2: #f7d9da;
  --uknrw-surface: #fafafa;
  --uknrw-text: #000000;
  --uknrw-cluster-fill: #f5f8fc;
  --uknrw-cluster-stroke: #c8d7e8;
  --uknrw-radius: 8px;

  /* Container als Service-Tile-Karte */
  background: var(--uknrw-surface);
  border: 1px solid #e6ebf2;
  border-radius: var(--uknrw-radius);
  padding: 12px;
}

/* SVG-Root: Segoe UI, transparent (Container liefert den Hintergrund) */
.mermaid-zoom-container svg.flowchart {
  background: transparent !important;
  font-family: "Segoe UI", sans-serif !important;
}

/* Default-Nodes: weisse Karte, Navy-Kontur, 2-Layer Card-Shadow */
.mermaid-zoom-container svg.flowchart .node rect,
.mermaid-zoom-container svg.flowchart .node circle,
.mermaid-zoom-container svg.flowchart .node ellipse,
.mermaid-zoom-container svg.flowchart .node polygon,
.mermaid-zoom-container svg.flowchart .node path {
  fill: var(--uknrw-white) !important;
  stroke: var(--uknrw-navy) !important;
  stroke-width: 1.5px !important;
}
.mermaid-zoom-container svg.flowchart .node rect {
  rx: var(--uknrw-radius) !important;
  ry: var(--uknrw-radius) !important;
}
.mermaid-zoom-container svg.flowchart .node rect,
.mermaid-zoom-container svg.flowchart .node circle,
.mermaid-zoom-container svg.flowchart .node ellipse,
.mermaid-zoom-container svg.flowchart .node polygon {
  filter: drop-shadow(0 0 2px rgba(0,0,0,0.12)) drop-shadow(0 4px 8px rgba(0,0,0,0.14));
}

/* Text: schwarz, Segoe UI 14px */
.mermaid-zoom-container svg.flowchart text,
.mermaid-zoom-container svg.flowchart .nodeLabel,
.mermaid-zoom-container svg.flowchart .edgeLabel,
.mermaid-zoom-container svg.flowchart foreignObject div,
.mermaid-zoom-container svg.flowchart foreignObject span {
  color: var(--uknrw-text) !important;
  fill: var(--uknrw-text) !important;
  font-family: "Segoe UI", sans-serif !important;
  font-size: 14px !important;
}

/* Kanten + Pfeilspitzen: Navy */
.mermaid-zoom-container svg.flowchart .edgePath .path,
.mermaid-zoom-container svg.flowchart .flowchart-link,
.mermaid-zoom-container svg.flowchart path.flowchart-link {
  stroke: var(--uknrw-navy) !important;
  stroke-width: 1.5px !important;
}
.mermaid-zoom-container svg.flowchart marker path,
.mermaid-zoom-container svg.flowchart .arrowheadPath {
  fill: var(--uknrw-navy) !important;
  stroke: var(--uknrw-navy) !important;
}

/* Kanten-Label-Hintergrund: weiss */
.mermaid-zoom-container svg.flowchart .edgeLabel,
.mermaid-zoom-container svg.flowchart .edgeLabel p,
.mermaid-zoom-container svg.flowchart .labelBkg {
  background: var(--uknrw-white) !important;
  fill: var(--uknrw-white) !important;
}

/* Subgraph / Cluster: leichter Navy-Tint */
.mermaid-zoom-container svg.flowchart .cluster rect {
  fill: var(--uknrw-cluster-fill) !important;
  stroke: var(--uknrw-cluster-stroke) !important;
  stroke-width: 1px !important;
  rx: var(--uknrw-radius) !important;
  ry: var(--uknrw-radius) !important;
}

/* Entscheidungs-Rauten (polygon): automatisch Akzent-Rot */
.mermaid-zoom-container svg.flowchart .node polygon {
  fill: var(--uknrw-red-tint) !important;
  stroke: var(--uknrw-red) !important;
  stroke-width: 1.8px !important;
}

/* Klasse :::primary -> gefuelltes Navy + weisse Schrift */
.mermaid-zoom-container svg.flowchart .node.primary rect,
.mermaid-zoom-container svg.flowchart .node.primary polygon,
.mermaid-zoom-container svg.flowchart .node.primary circle,
.mermaid-zoom-container svg.flowchart .node.primary ellipse,
.mermaid-zoom-container svg.flowchart .node.primary path {
  fill: var(--uknrw-navy) !important;
  stroke: var(--uknrw-navy) !important;
}
.mermaid-zoom-container svg.flowchart .node.primary text,
.mermaid-zoom-container svg.flowchart .node.primary .nodeLabel,
.mermaid-zoom-container svg.flowchart .node.primary foreignObject div,
.mermaid-zoom-container svg.flowchart .node.primary foreignObject span {
  fill: var(--uknrw-white) !important;
  color: var(--uknrw-white) !important;
}

/* Klasse :::danger / :::accent -> Akzent-Rot kraeftig, schwarze Schrift */
.mermaid-zoom-container svg.flowchart .node.danger rect,
.mermaid-zoom-container svg.flowchart .node.danger polygon,
.mermaid-zoom-container svg.flowchart .node.danger circle,
.mermaid-zoom-container svg.flowchart .node.danger ellipse,
.mermaid-zoom-container svg.flowchart .node.danger path,
.mermaid-zoom-container svg.flowchart .node.accent rect,
.mermaid-zoom-container svg.flowchart .node.accent polygon,
.mermaid-zoom-container svg.flowchart .node.accent circle,
.mermaid-zoom-container svg.flowchart .node.accent ellipse,
.mermaid-zoom-container svg.flowchart .node.accent path {
  fill: var(--uknrw-red-tint-2) !important;
  stroke: var(--uknrw-red) !important;
  stroke-width: 2.5px !important;
}
```

### Node-Klassen-Konvention (für Diagramm-Autoren)

- `Node:::primary` → gefülltes Navy + weiße Schrift (wie Primary-Button)
- `Node:::danger` / `Node:::accent` → Akzent-Rot kräftig, schwarze Schrift
- Entscheidungs-Rauten `{...}` werden automatisch rot (kein Klassen-Zuweisen nötig)
- Spezifität: `.node.primary polygon` (2 Klassen) schlägt die Auto-Rauten-Regel `.node polygon` - eine als `primary` markierte Raute wird also Navy statt Rot.

---

## Migration (im uvitas-Vault, NACH dem Plugin-Update)

Das globale Snippet wird durch das Plugin-Feld ersetzt - sonst doppelte Anwendung:

1. `uvitas/.obsidian/appearance.json` → `mermaid-theme_uknrw` aus `enabledCssSnippets` entfernen.
2. Optional: Datei `uvitas/.obsidian/snippets/mermaid-theme_uknrw.css` löschen.
3. Theme-CSS (oben) ins neue Plugin-Feld einfügen. Die zwei Flach-Felder leer lassen.

---

## Hinweise / Edge Cases

- **Dark/Light:** `background: var(--uknrw-surface)` erzwingt bewusst den hellen "Portal Light"-Look auch im Dark Mode. Soll der Container theme-adaptiv sein, stattdessen `var(--background-primary)` setzen und Node-Texte auf `var(--text-normal)`.
- **`!important` ist Pflicht:** Mermaid setzt viele Styles inline am Element - ohne `!important` greift das Theme nicht zuverlässig.
- **SVG kennt kein `box-shadow`:** Card-Shadow daher via `filter: drop-shadow(...)` (zwei gestapelte = zwei Shadow-Layer).
- **Sicherheit:** Das Feld enthält ausschließlich vom Nutzer selbst eingegebenes CSS, injiziert in einen `<style>` im eigenen Vault - kein Fremdinhalt, kein XSS-Vektor über das hinaus, was CSS ohnehin erlaubt.
- **Robustheit:** Da `customThemeCSS` als letzter `parts`-Eintrag steht, kann fehlerhaftes CSS die funktionalen Hover-/Container-Regeln nicht beschädigen.
- **Scope:** Alle Regeln unter `.mermaid-zoom-container` - normale (nicht gezoomte) Mermaid-Renderings bleiben unberührt. Wer auch die statische Vorschau theme-n will, das Snippet zusätzlich behalten oder den Scope erweitern.

---

## Optionale Ausbaustufe (später, nicht Teil dieses Plans)

Theme-Presets als Dropdown (`None | UK NRW | DGUV`), die das `customThemeCSS`-Feld vorbefüllen ("Load preset"-Button) - vereint Sofort-Verfügbarkeit mit voller Editierbarkeit. Erst umsetzen, wenn ein zweites Theme tatsächlich gebraucht wird (YAGNI).
