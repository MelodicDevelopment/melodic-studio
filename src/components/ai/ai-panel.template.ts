import { html } from '@melodicdev/core/template';
import type { AiPanelComponent } from './ai-panel.component';
import type { ExplainState, ReviewState } from '../../services/ai-features.store';
import type { Finding, Severity } from '../../services/ai-prompts';
import { dirName, fileName, plural } from '../../shared/format';
import { renderMarkdown } from './markdown';

const SEVERITY_LABEL: Record<Severity, string> = { bug: 'Bug', risk: 'Risk', nit: 'Nit' };

function isBusy(state: string): boolean {
	return state === 'collecting' || state === 'running';
}

function wait(text: string, small = false) {
	return html`<div class="wait ${small ? 'small' : ''}"><ml-spinner size="sm"></ml-spinner><span>${text}</span></div>`;
}

function explainBody(self: AiPanelComponent, ex: ExplainState) {
	const ai = self.ai;
	const busy = isBusy(ex.state);
	return html`
		<div class="sub">
			<div class="t">${ex.title}</div>
			<div class="d" title=${ex.detail}>${ex.detail}</div>
		</div>
		<div class="body">
			${ex.text ? renderMarkdown(ex.text) : busy ? wait(ex.state === 'collecting' ? 'Reading the diff…' : 'Claude is reading the change…') : ''}
			${ex.text && busy ? wait('Still writing…', true) : ''}
			${ex.state === 'stopped' ? html`<div class="notice">Stopped${ex.text ? ' before the explanation was finished' : ''}.</div>` : ''}
			${ex.state === 'error' ? html`<div class="notice error">${ex.error}</div>` : ''}
		</div>
		<div class="foot">
			${busy
				? html`<ml-button variant="outline" size="sm" @ml:click=${() => ai.stopExplain()}><ml-icon slot="icon-start" icon="stop" size="sm"></ml-icon>Stop</ml-button>`
				: html`
					<ml-button variant="outline" size="sm" @ml:click=${() => ai.explain(ex.target)}><ml-icon slot="icon-start" icon="arrow-clockwise" size="sm"></ml-icon>Explain again</ml-button>
					${ex.text ? html`<ml-button variant="ghost" size="sm" @ml:click=${() => self.copy(ex.text)}><ml-icon slot="icon-start" icon="copy" size="sm"></ml-icon>Copy</ml-button>` : ''}
				`}
		</div>
	`;
}

function findingRow(self: AiPanelComponent, f: Finding) {
	const view = self.ai.reviewView();
	const open = !!view && view.path === f.file && view.line === f.line;
	return html`
		<div class="finding ${f.severity} ${open ? 'open' : ''}" title="Show this in the diff" @click=${() => self.ai.openFinding(f)}>
			<div class="ft"><span class="sev">${SEVERITY_LABEL[f.severity]}</span><span class="title">${f.title}</span></div>
			${f.detail ? html`<div class="fd">${renderMarkdown(f.detail)}</div>` : ''}
			<div class="fl">${f.line !== null ? `Line ${f.line}` : 'Whole file'}</div>
		</div>
	`;
}

function findings(self: AiPanelComponent, rv: ReviewState) {
	if (!rv.findings.length) {
		return html`
			<div class="clean">
				<ml-icon icon="check-circle" size="lg"></ml-icon>
				<b>No problems found</b>
				<span>${rv.summary || 'Claude found nothing in these commits that needs fixing before you push.'}</span>
			</div>
		`;
	}
	const files = [...new Set(rv.findings.map((f) => f.file))];
	const count = (s: Severity): number => rv.findings.filter((f) => f.severity === s).length;
	return html`
		${rv.summary ? html`<p class="summary">${rv.summary}</p>` : ''}
		<div class="counts">
			${(['bug', 'risk', 'nit'] as Severity[]).filter(count).map((s) => html`<span class="chip ${s}">${plural(count(s), SEVERITY_LABEL[s].toLowerCase())}</span>`)}
		</div>
		${files.map(
			(path) => html`
				<div class="group" title=${path}><span class="dir">${dirName(path)}</span><span class="file">${fileName(path)}</span></div>
				${rv.findings.filter((f) => f.file === path).map((f) => findingRow(self, f))}
			`
		)}
	`;
}

function reviewBody(self: AiPanelComponent, rv: ReviewState) {
	const ai = self.ai;
	const busy = isBusy(rv.state);
	const range = rv.range;
	return html`
		<div class="sub">
			<div class="t">Before you push</div>
			<div class="d">${range ? `${plural(range.commits.length, 'commit')} and ${plural(range.files.length, 'changed file')}, compared with ${range.against}` : 'Everything a push would send'}</div>
		</div>
		<div class="body">
			${rv.state === 'collecting' ? wait('Reading what would be pushed…') : ''}
			${rv.state === 'running'
				? html`
					${wait('Claude is reviewing the changes. It may open files around them, so this can take a minute or two.')}
					${rv.progress ? html`<div class="progress">${rv.progress}</div>` : ''}
				`
				: ''}
			${rv.state === 'done' ? findings(self, rv) : ''}
			${rv.state === 'stopped' ? html`<div class="notice">The review was stopped. Nothing was reported.</div>` : ''}
			${rv.state === 'error' ? html`<div class="notice error">${rv.error}</div>${rv.raw ? html`<div class="raw">${renderMarkdown(rv.raw)}</div>` : ''}` : ''}
			${rv.state === 'done' && range?.truncated ? html`<div class="notice">Some of the diff was too long to send whole, so large files were only partly reviewed.</div>` : ''}
		</div>
		<div class="foot">
			${busy
				? html`<ml-button variant="outline" size="sm" @ml:click=${() => ai.stopReview()}><ml-icon slot="icon-start" icon="stop" size="sm"></ml-icon>Stop</ml-button>`
				: html`<ml-button variant="outline" size="sm" @ml:click=${() => ai.review()}><ml-icon slot="icon-start" icon="arrow-clockwise" size="sm"></ml-icon>Review again</ml-button>`}
		</div>
	`;
}

export function aiPanelTemplate(self: AiPanelComponent) {
	const ai = self.ai;
	const ex = ai.explanation();
	const rv = ai.reviewed();
	const tab = ex && rv ? ai.panelTab() : ex ? 'explain' : 'review';
	return html`
		<div class="grip" @pointerdown=${self.startResize}></div>
		<div class="head">
			${ex && rv
				? html`
					<button class="tab ${tab === 'explain' ? 'on' : ''}" @click=${() => ai.panelTab.set('explain')}>Explanation${isBusy(ex.state) ? html`<ml-spinner size="sm"></ml-spinner>` : ''}</button>
					<button class="tab ${tab === 'review' ? 'on' : ''}" @click=${() => ai.panelTab.set('review')}>
						Review${isBusy(rv.state) ? html`<ml-spinner size="sm"></ml-spinner>` : rv.state === 'done' && rv.findings.length ? html`<span class="count">${rv.findings.length}</span>` : ''}
					</button>
				`
				: html`<span class="name"><ml-icon icon="sparkle" size="sm"></ml-icon>${tab === 'explain' ? 'Explanation' : 'Review'}</span>`}
			<span class="grow"></span>
			<button class="icon" title="Close" @click=${() => (tab === 'explain' ? ai.closeExplain() : ai.closeReview())}><ml-icon icon="x" size="sm"></ml-icon></button>
		</div>
		${tab === 'explain' && ex ? explainBody(self, ex) : rv ? reviewBody(self, rv) : ''}
	`;
}
