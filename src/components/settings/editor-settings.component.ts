import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { EditorSettingsStore, FONT_SIZES, type EditorSettings, type Whitespace } from '../../services/editor-settings.store';
import { isMac } from '../../services/backend.service';

const LINE_HEIGHTS = [
	{ value: '1.4', label: 'Compact' },
	{ value: '1.65', label: 'Normal' },
	{ value: '1.9', label: 'Relaxed' },
];
const TAB_SIZES = [
	{ value: '0', label: 'From the file' },
	{ value: '2', label: '2 spaces' },
	{ value: '4', label: '4 spaces' },
	{ value: '8', label: '8 spaces' },
];
const WHITESPACE = [
	{ value: 'none', label: 'Never' },
	{ value: 'selection', label: 'In a selection' },
	{ value: 'boundary', label: 'Between words and at line ends' },
	{ value: 'all', label: 'Always' },
];
const AUTO_SAVE = [
	{ value: 'off', label: `Off: save with ${isMac() ? '⌘' : 'Ctrl+'}S` },
	{ value: 'delay', label: 'A second after typing stops' },
	{ value: 'focus', label: 'When the window loses focus' },
];
const ZOOM_LABELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((z) => ({ value: String(z), label: `${Math.round(z * 100)}%` }));

/** Settings > Editor: how code looks in the editor, the diff view and the terminals, and the window's zoom. */
@MelodicComponent({
	selector: 'ms-editor-settings',
	template: (self: EditorSettingsComponent) => {
		const store = self.store;
		const s = store.settings();
		const mod = isMac() ? '⌘' : 'Ctrl+';
		const toggle = (key: keyof EditorSettings, label: string, hint = '') =>
			html`<ml-toggle label=${label} hint=${hint} .checked=${!!s[key]} @ml:change=${(e: CustomEvent) => store.set(key, e.detail.checked as never)}></ml-toggle>`;
		return html`
			<div class="grid">
				<ml-input label="Font" placeholder="JetBrains Mono (the app's own)" .value=${s.fontFamily} @ml:input=${(e: CustomEvent) => store.set('fontFamily', e.detail.value)}></ml-input>
				<ml-input label="Size" type="number" min=${FONT_SIZES.min} max=${FONT_SIZES.max} .value=${String(s.fontSize)} @ml:change=${(e: CustomEvent) => store.set('fontSize', Number(e.detail.value))}></ml-input>
			</div>
			<small>Any font installed on this computer, by name. Also used by the diff view and terminals. ${mod}⌥= and ${mod}⌥− change the size from the editor.</small>
			<div class="preview" style="font-family: ${store.font()}; font-size: ${s.fontSize}px; line-height: ${store.lineHeightPx()}px; font-variant-ligatures: ${s.ligatures ? 'normal' : 'none'}">
				const answer = (a: number) =&gt; a !== 42 ? 'try again' : 'yes';
			</div>
			<div class="grid">
				<ml-select label="Line spacing" .options=${LINE_HEIGHTS} .value=${String(s.lineHeight)} @ml:change=${(e: CustomEvent) => store.set('lineHeight', Number(e.detail.value))}></ml-select>
				<ml-select label="Tab size" .options=${TAB_SIZES} .value=${String(s.tabSize)} @ml:change=${(e: CustomEvent) => store.set('tabSize', Number(e.detail.value) as EditorSettings['tabSize'])}></ml-select>
			</div>
			<ml-select label="Show spaces and tabs" .options=${WHITESPACE} .value=${s.whitespace} @ml:change=${(e: CustomEvent) => store.set('whitespace', e.detail.value as Whitespace)}></ml-select>
			<div class="toggles">
				${toggle('wordWrap', 'Wrap long lines')}
				${toggle('minimap', 'Minimap')}
				${toggle('lineNumbers', 'Line numbers')}
				${toggle('stickyScroll', 'Sticky scroll', 'Keeps the enclosing function or class at the top')}
				${toggle('bracketColors', 'Colour matching brackets')}
				${toggle('ligatures', 'Font ligatures', 'For fonts that have them (Fira Code, JetBrains Mono)')}
				${toggle('cursorBlink', 'Blinking cursor')}
			</div>
			<ml-input label="Rulers" placeholder="80, 120" hint="Columns to draw a guide at. An .editorconfig max_line_length adds one." .value=${s.rulers} @ml:input=${(e: CustomEvent) => store.set('rulers', e.detail.value)}></ml-input>
			<h4>Saving</h4>
			<ml-select label="Auto-save" .options=${AUTO_SAVE} .value=${s.autoSave} @ml:change=${(e: CustomEvent) => store.set('autoSave', e.detail.value as EditorSettings['autoSave'])}></ml-select>
			<div class="toggles">
				${toggle('formatOnSave', 'Format on save', `${mod}S formats the file first: with the project's own Prettier when it has one, else its language server or the editor's own formatter`)}
				${toggle('trimTrailing', 'Trim trailing spaces on save')}
				${toggle('finalNewline', 'End files with a newline on save')}
				${toggle('editorconfig', "Follow the repository's .editorconfig", 'Indentation, trimming and the final newline per file type; it wins over the settings here')}
			</div>
			<div class="grid">
				<ml-input label="Terminal text size" type="number" min=${FONT_SIZES.min} max=${FONT_SIZES.max} .value=${String(s.terminalFontSize)} @ml:change=${(e: CustomEvent) => store.set('terminalFontSize', Number(e.detail.value))}></ml-input>
				<ml-select label="Window zoom" .options=${ZOOM_LABELS} .value=${String(store.zoom())} @ml:change=${(e: CustomEvent) => store.setZoom(Number(e.detail.value))}></ml-select>
			</div>
			<small>Zoom scales the whole window: ${mod}+ and ${mod}− (${mod}0 for 100%).</small>
			<div class="end"><ml-button variant="ghost" size="sm" @ml:click=${() => store.reset()}>Restore defaults</ml-button></div>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}
		.grid {
			display: grid;
			grid-template-columns: 1fr 120px;
			gap: 10px;
			align-items: end;
		}
		small {
			margin-top: -6px;
			color: var(--ml-color-text-muted);
		}
		.preview {
			padding: 8px 10px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
			background: var(--ml-color-surface-sunken, var(--ml-color-surface));
			white-space: pre;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.toggles {
			display: grid;
			gap: 8px;
		}
		h4 {
			margin: 6px 0 -4px;
			color: var(--ml-color-text);
			font-weight: 600;
		}
		.end {
			display: flex;
			justify-content: flex-end;
		}
	`,
})
export class EditorSettingsComponent {
	@Service(EditorSettingsStore) readonly store!: EditorSettingsStore;
}
