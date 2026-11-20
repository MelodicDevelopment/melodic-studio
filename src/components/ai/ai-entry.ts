/**
 * Where the AI features around changes hook into the rest of the app. The existing
 * templates (app, changes, history) call these and place what they return; everything
 * else lives in this folder and in services/ai-features.store.ts.
 */
import { html } from '@melodicdev/core/template';
import { Injector } from '@melodicdev/core/injection';
import { AiFeaturesStore } from '../../services/ai-features.store';
import { RepoStore } from '../../services/repo.store';
import type { ExplainTarget } from '../../services/ai-prompts';
import type { FileChange } from '../../services/backend.service';

/**
 * What a component renders when it has nothing to show. Not an empty template: Melodic does
 * not pick up a later, non-empty template in a root that first rendered an empty one.
 */
export const nothing = () => html`<span hidden></span>`;

function ai(): AiFeaturesStore {
	const store = Injector.get(AiFeaturesStore);
	store.init();
	return store;
}

function sameTarget(a: ExplainTarget, b: ExplainTarget): boolean {
	return a.kind === 'file' ? b.kind === 'file' && a.file.path === b.file.path : b.kind === 'commit' && a.commit.hash === b.commit.hash;
}

/** "Explain" for one uncommitted file's diff or one commit. The answer opens in the side panel. */
export function explainButton(target: ExplainTarget, style = '') {
	const store = ai();
	const off = store.unavailable();
	const now = store.explanation();
	const busy = !!now && sameTarget(now.target, target) && (now.state === 'collecting' || now.state === 'running');
	return html`
		<ml-button variant="ghost" size="sm" style=${style} title=${off || 'Explain this change in plain language'} ?disabled=${!!off} ?loading=${busy} @ml:click=${() => store.explain(target)}>
			<ml-icon slot="icon-start" icon="sparkle" size="sm"></ml-icon>Explain
		</ml-button>
	`;
}

/** The action in the Changes tab's file header: explain the diff, or propose a resolution for a conflicted file. */
export function fileAction(file: FileChange) {
	if (file.status !== 'conflicted') {
		return explainButton({ kind: 'file', file });
	}
	const store = ai();
	const off = store.unavailable();
	return html`
		<ml-button variant="ghost" size="sm" title=${off || 'Ask Claude for a resolution. Nothing is written until you accept it.'} ?disabled=${!!off || !!store.proposalFor(file.path)} @ml:click=${() => store.proposeResolution(file)}>
			<ml-icon slot="icon-start" icon="sparkle" size="sm"></ml-icon>Propose a resolution
		</ml-button>
	`;
}

/** The same, as a row of the Changes list's right-click menu (shown for conflicted files). */
export function proposeMenuItem(file: FileChange) {
	const store = ai();
	const off = store.unavailable();
	return html`<div class="ctx-item" title=${off} style=${off ? 'opacity: 0.5' : ''} @click=${() => store.proposeResolution(file)}><ml-icon icon="sparkle" size="sm"></ml-icon>Propose a resolution</div>`;
}

/** What the main pane shows instead of a diff while a proposal exists for `file`; null otherwise. */
export function proposalPane(file: FileChange) {
	return ai().proposalFor(file.path) ? html`<ms-ai-proposal></ms-ai-proposal>` : null;
}

/** What takes over the main pane while a review finding is open; null otherwise. */
export function reviewPane() {
	return ai().reviewView() ? html`<ms-ai-review-diff></ms-ai-review-diff>` : null;
}

/** The panel beside the main pane: the explanation and/or the review. */
export function aiSidePanel() {
	return ai().panelOpen() ? html`<ms-ai-panel></ms-ai-panel>` : '';
}

/** Cards for the "No local changes" screen, next to the push card: one for each thing Claude can review here. */
export function reviewCard() {
	const store = ai();
	const offers = store.offers();
	if (!offers.length) {
		return '';
	}
	const off = store.unavailable();
	const busy = Injector.get(RepoStore).busy() === 'push';
	return offers.map(
		(o) => html`
			<button class="card" ?disabled=${!!off || busy} title=${off} @click=${() => store.review(o.request)}>
				<ml-icon icon="sparkle" size="md"></ml-icon>
				<span><b>${o.title}</b><small>${o.detail}</small></span>
			</button>
		`
	);
}
