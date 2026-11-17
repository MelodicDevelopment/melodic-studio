/**
 * xterm.js (the terminal from VS Code), loaded the first time a terminal is
 * opened so it costs nothing at startup. Also bridges the two things xterm
 * does not know about: the app theme, and the shadow root it is mounted in.
 */
import type { ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export interface XtermApi {
	Terminal: typeof Terminal;
	FitAddon: typeof FitAddon;
}

let _loading: Promise<XtermApi> | null = null;
let _sheet: CSSStyleSheet | null = null;

export function loadXterm(): Promise<XtermApi> {
	return (_loading ??= load());
}

async function load(): Promise<XtermApi> {
	const [xterm, fit, css] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css?inline')]);
	_sheet = new CSSStyleSheet();
	_sheet.replaceSync(css.default);
	return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
}

/** xterm's CSS does not reach into a shadow root from <head>, so the root adopts it. Call after loadXterm(). */
export function adoptXtermStyles(root: Node): void {
	if (_sheet && root instanceof ShadowRoot && !root.adoptedStyleSheets.includes(_sheet)) {
		root.adoptedStyleSheets = [...root.adoptedStyleSheets, _sheet];
	}
}

// ---- theme ------------------------------------------------------------------

let _ctx: CanvasRenderingContext2D | null = null;

/** A theme token as a colour xterm can parse (`#rrggbb` or `rgba()`), whatever notation the CSS used. */
function token(name: string): string | undefined {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	_ctx ??= document.createElement('canvas').getContext('2d');
	if (!value || !_ctx) {
		return undefined;
	}
	// The canvas keeps the old fill when it cannot parse the new one; two different olds tell that apart.
	_ctx.fillStyle = '#000000';
	_ctx.fillStyle = value;
	const out = String(_ctx.fillStyle);
	if (out === '#000000') {
		_ctx.fillStyle = '#ffffff';
		_ctx.fillStyle = value;
		return String(_ctx.fillStyle) === '#000000' ? out : undefined;
	}
	return out;
}

function isDark(color: string | undefined): boolean {
	const m = /^#(..)(..)(..)/.exec(color ?? '');
	return m ? 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16) < 128 : document.documentElement.getAttribute('data-theme') === 'dark';
}

/**
 * The terminal wears the app's surface, text and accent; the sixteen ANSI
 * colours come from Melodic's palette, a lighter step of each on a dark surface.
 */
export function xtermTheme(): ITheme {
	const background = token('--ml-color-surface');
	const dark = isDark(background);
	const [normal, bright] = dark ? [400, 300] : [600, 500];
	const hue = (name: string, step: number): string | undefined => token(`--ml-${name}-${step}`);
	const theme: ITheme = {
		background,
		foreground: token('--ml-color-text'),
		cursor: token('--ml-color-primary'),
		cursorAccent: background,
		selectionBackground: token('--ms-selected'),
		selectionInactiveBackground: token('--ms-hover'),
		scrollbarSliderBackground: token('--ml-color-border'),
		scrollbarSliderHoverBackground: token('--ml-color-border-strong'),
		scrollbarSliderActiveBackground: token('--ml-color-border-strong'),
		black: hue('gray', dark ? 700 : 900),
		red: hue('red', normal),
		green: hue('green', normal),
		yellow: hue('amber', normal),
		blue: hue('blue', normal),
		magenta: hue('purple', normal),
		cyan: hue('cyan', normal),
		white: hue('gray', dark ? 300 : 600),
		brightBlack: hue('gray', 500),
		brightRed: hue('red', bright),
		brightGreen: hue('green', bright),
		brightYellow: hue('amber', bright),
		brightBlue: hue('blue', bright),
		brightMagenta: hue('purple', bright),
		brightCyan: hue('cyan', bright),
		brightWhite: hue('gray', dark ? 50 : 400),
	};
	// A token the theme does not define stays out, so xterm keeps its own default for that slot.
	for (const key of Object.keys(theme) as (keyof ITheme)[]) {
		if (theme[key] === undefined) {
			delete theme[key];
		}
	}
	return theme;
}

/** The app's monospace stack, resolved (xterm measures glyphs, so it needs real font names). */
export function termFont(): string {
	return getComputedStyle(document.documentElement).getPropertyValue('--ml-font-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
}
