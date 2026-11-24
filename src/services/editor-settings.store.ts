/**
 * How code looks: the editor (Monaco), the diff view and the terminals, plus the window's zoom. Per computer,
 * in localStorage (`studio.editor`, `studio.zoom`); nothing here touches a repository.
 */
import { Injectable } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { isDesktop } from './backend.service';

export type Whitespace = 'none' | 'boundary' | 'selection' | 'all';

export interface EditorSettings {
	/** Empty: the app's own monospace font (JetBrains Mono). */
	fontFamily: string;
	fontSize: number;
	/** A multiple of the font size. */
	lineHeight: number;
	ligatures: boolean;
	/** 0: detect from the file. */
	tabSize: 0 | 2 | 4 | 8;
	wordWrap: boolean;
	minimap: boolean;
	lineNumbers: boolean;
	stickyScroll: boolean;
	bracketColors: boolean;
	/** Names coloured by what a language server says they are (a parameter, a constant, a type), over the grammar's colours. */
	semanticColors: boolean;
	/** The line above a function or type saying how often it is used ("3 references"), where a language server counts. */
	codeLens: boolean;
	whitespace: Whitespace;
	cursorBlink: boolean;
	terminalFontSize: number;
	/** Columns for vertical guides, e.g. "80, 120". */
	rulers: string;
	/** `delay`: a second after typing stops; `focus`: when the window loses focus. */
	autoSave: 'off' | 'delay' | 'focus';
	trimTrailing: boolean;
	finalNewline: boolean;
	formatOnSave: boolean;
	/** Follow the repository's `.editorconfig`, which wins over the settings above for its files. */
	editorconfig: boolean;
}

export const EDITOR_DEFAULTS: EditorSettings = {
	fontFamily: '',
	fontSize: 12,
	lineHeight: 1.65,
	ligatures: false,
	tabSize: 0,
	wordWrap: false,
	minimap: true,
	lineNumbers: true,
	stickyScroll: false,
	bracketColors: true,
	semanticColors: true,
	codeLens: true,
	whitespace: 'selection',
	cursorBlink: true,
	terminalFontSize: 12,
	rulers: '',
	autoSave: 'off',
	trimTrailing: false,
	finalNewline: false,
	formatOnSave: false,
	editorconfig: true,
};

export const FONT_SIZES = { min: 8, max: 32 };
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const KEY = 'studio.editor';
const ZOOM_KEY = 'studio.zoom';

const FALLBACK_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function load(): EditorSettings {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<EditorSettings>;
		return clean({ ...EDITOR_DEFAULTS, ...saved });
	} catch {
		return { ...EDITOR_DEFAULTS };
	}
}

function clean(s: EditorSettings): EditorSettings {
	const size = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, n))) : fallback);
	return {
		...s,
		fontFamily: typeof s.fontFamily === 'string' ? s.fontFamily.trim() : '',
		fontSize: size(s.fontSize, EDITOR_DEFAULTS.fontSize),
		terminalFontSize: size(s.terminalFontSize, EDITOR_DEFAULTS.terminalFontSize),
		lineHeight: typeof s.lineHeight === 'number' && s.lineHeight >= 1 && s.lineHeight <= 2.5 ? s.lineHeight : EDITOR_DEFAULTS.lineHeight,
		tabSize: [0, 2, 4, 8].includes(s.tabSize) ? s.tabSize : 0,
		whitespace: ['none', 'boundary', 'selection', 'all'].includes(s.whitespace) ? s.whitespace : 'selection',
		rulers: typeof s.rulers === 'string' ? s.rulers : '',
		autoSave: ['off', 'delay', 'focus'].includes(s.autoSave) ? s.autoSave : 'off',
	};
}

function loadZoom(): number {
	try {
		const z = Number(localStorage.getItem(ZOOM_KEY));
		return ZOOMS.includes(z) ? z : 1;
	} catch {
		return 1;
	}
}

@Injectable()
export class EditorSettingsStore {
	readonly settings = signal<EditorSettings>(load());
	/** The whole window's zoom, 1 is 100%. */
	readonly zoom = signal<number>(loadZoom());

	constructor() {
		this.applyCss();
	}

	set<K extends keyof EditorSettings>(key: K, value: EditorSettings[K]): void {
		this.settings.set(clean({ ...this.settings(), [key]: value }));
		this.save();
	}

	reset(): void {
		this.settings.set({ ...EDITOR_DEFAULTS });
		this.save();
	}

	/** The font stack for code: the chosen family first, then the app's own, then the system's. */
	font(): string {
		const app = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--ml-font-mono').trim();
		const chosen = this.settings().fontFamily;
		const quoted = chosen && !/[,'"]/.test(chosen) ? `"${chosen}"` : chosen;
		return [quoted, app || FALLBACK_MONO].filter(Boolean).join(', ');
	}

	/** The ruler columns, plus `extra` (an .editorconfig max_line_length). */
	rulers(extra?: number): number[] {
		const cols = this.settings()
			.rulers.split(/[\s,]+/)
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0 && n < 1000);
		return [...new Set(extra ? [...cols, extra] : cols)].sort((a, b) => a - b);
	}

	lineHeightPx(): number {
		const s = this.settings();
		return Math.round(s.fontSize * s.lineHeight);
	}

	/** Bigger or smaller text in the editor alone (`0` resets), as the editor's own zoom keys do. */
	nudgeFont(step: -1 | 0 | 1): void {
		this.set('fontSize', step === 0 ? EDITOR_DEFAULTS.fontSize : this.settings().fontSize + step);
	}

	// ---- window zoom ----

	/** One step bigger or smaller, or (`0`) back to 100%. */
	stepZoom(step: -1 | 0 | 1): void {
		const now = this.zoom();
		const at = ZOOMS.indexOf(now);
		const next = step === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (at < 0 ? ZOOMS.indexOf(1) : at) + step))];
		this.setZoom(next);
	}

	setZoom(zoom: number): void {
		this.zoom.set(ZOOMS.includes(zoom) ? zoom : 1);
		try {
			localStorage.setItem(ZOOM_KEY, String(this.zoom()));
		} catch {
			/* per-viewer convenience only */
		}
		void this.applyZoom();
	}

	/** Put the saved zoom on the window. Called once at startup and after every change. */
	async applyZoom(): Promise<void> {
		const zoom = this.zoom();
		if (isDesktop()) {
			try {
				const { getCurrentWebview } = await import('@tauri-apps/api/webview');
				await getCurrentWebview().setZoom(zoom);
				return;
			} catch {
				/* fall through to CSS zoom */
			}
		}
		document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
	}

	private save(): void {
		try {
			localStorage.setItem(KEY, JSON.stringify(this.settings()));
		} catch {
			/* per-viewer convenience only */
		}
		this.applyCss();
	}

	/** Components that draw code themselves (the diff view) read these. */
	private applyCss(): void {
		if (typeof document === 'undefined') {
			return;
		}
		const root = document.documentElement.style;
		const s = this.settings();
		root.setProperty('--ms-code-font', this.font());
		root.setProperty('--ms-code-size', `${s.fontSize}px`);
		root.setProperty('--ms-code-line', `${this.lineHeightPx()}px`);
	}
}
