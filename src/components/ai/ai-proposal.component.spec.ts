import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import { parseDiff } from '../../shared/diff';
import type { AiFeaturesStore, ProposalState } from '../../services/ai-features.store';
import type { RepoStore } from '../../services/repo.store';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const PATH = 'src/player/shuffle.ts';
const ORIGINAL = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n';
const RESOLVED = 'both\n';

let w: World;
let repos: RepoStore;
let ai: AiFeaturesStore;

/**
 * happy-dom keeps one registry of custom elements for the whole file and Melodic never defines a name
 * twice, so without this the elements of a later test would still be the first test's classes, tied
 * to the first test's stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const held = registry[key];
		if (held instanceof Map) {
			held.clear();
		}
	}
}

beforeEach(async () => {
	forgetElements();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	repos.setTab('changes');
	ai = w.get((await import('../../services/ai-features.store')).AiFeaturesStore);
});

/** Tags that mark words inside a sentence: nothing is read between them and the words around them. */
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'U']);

/**
 * What a person reads under `root`, through shadow roots: text that stands together stays together,
 * the icons' glyphs are left out, and so is a dialog that is not open.
 */
function read(root: Element | ShadowRoot): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
		} else if (node instanceof Element) {
			const closed = node.tagName === 'ML-DIALOG' && !node.shadowRoot?.querySelector('dialog')?.open;
			if (node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT' && !closed) {
				const gap = INLINE.has(node.tagName) ? '' : ' ';
				parts.push(gap);
				if (node.shadowRoot) {
					walk(node.shadowRoot);
				}
				node.childNodes.forEach(walk);
				parts.push(gap);
			}
		} else {
			node.childNodes.forEach(walk);
		}
	};
	walk(root);
	return parts
		.join('')
		.replace(/[\uE000-\uF8FF]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function button(root: Element, label: string | RegExp): HTMLElement | null {
	return all(root, 'ml-button, button').find((b) => (typeof label === 'string' ? read(b) === label : label.test(read(b)))) ?? null;
}

/** A click on a button; an `ml-button` listens on the button inside it. */
async function press(el: Element | null): Promise<void> {
	if (!el) {
		throw new Error('nothing to press');
	}
	await click(el.tagName === 'ML-BUTTON' ? find(el, 'button') : el);
}

const disabled = (el: Element | null): boolean => !!el && el.hasAttribute('disabled');

function proposal(over: Partial<ProposalState> = {}): ProposalState {
	return {
		path: PATH,
		root: REPO,
		state: 'ready',
		conflicts: 1,
		original: ORIGINAL,
		text: RESOLVED,
		summary: 'Kept the seed from **ours** and the readonly type from theirs.',
		diff: parseDiff(`diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -1,5 +1,1 @@\n-<<<<<<< HEAD\n-ours\n-=======\n-theirs\n->>>>>>> origin/main\n+both\n`),
		...over,
	};
}

/** The pane that stands in for a conflicted file's diff while a proposal exists for it. */
async function pane(p: ProposalState | null): Promise<HTMLElement> {
	ai.proposal.set(p);
	return mount('ms-ai-proposal');
}

describe('a proposed resolution', () => {
	test('shows nothing until there is one, and then the proposal', async () => {
		const el = await pane(null);
		expect(read(el)).toBe('');
		ai.proposal.set(proposal());
		await settle();
		expect(read(el)).toContain('Proposed resolution for 1 conflict');
	});

	test('says it is a preview: nothing is written until it is accepted', async () => {
		const el = await pane(proposal());
		const shown = read(el);
		expect(shown).toContain('Kept the seed from ours and the readonly type from theirs.');
		expect(shown).toContain('This is a preview: the file has not been changed. Accepting writes it and marks the conflict resolved.');
		expect(button(el, 'Accept')).not.toBeNull();
		expect(button(el, 'Discard')).not.toBeNull();
		expect(w.sent('ai_resolution_apply')).toEqual([]);
	});

	test('shows what would change as a diff against the file as it is', async () => {
		const el = await pane(proposal());
		const diff = find(el, 'ms-diff') as HTMLElement & { diff: { added: number; removed: number } };
		expect(diff.diff).toMatchObject({ added: 1, removed: 5 });
		expect(read(diff)).toContain('both');
	});

	test('Claude’s summary is text', async () => {
		const el = await pane(proposal({ summary: '<img src=x onerror=alert(1)> kept `ours`' }));
		expect(find(el, 'img')).toBeNull();
		expect(read(el)).toContain('<img src=x onerror=alert(1)> kept ours');
	});

	test('Accept writes the proposal over the file it was made from, in the checkout it was read in, and says so', async () => {
		const el = await pane(proposal());
		await press(button(el, 'Accept'));
		expect(w.sent('ai_resolution_apply').map((c) => c.args)).toEqual([{ id: REPO, path: PATH, text: RESOLVED, original: ORIGINAL, root: REPO }]);
		expect(ai.proposal()).toBeNull();
		expect(w.toasts.map((t) => [t.kind, t.title])).toEqual([['success', 'Conflict resolved']]);
		// The status is read again, so Changes shows the file as it now is.
		expect(w.sent('repo_status').length).toBeGreaterThan(1);
		expect(read(el)).toBe('');
	});

	test('a file that changed since it was read is not overwritten: the refusal is said and the proposal dropped', async () => {
		w.on('ai_resolution_apply', () => {
			throw { kind: 'error', message: 'The file changed since the proposal was made.', paths: [PATH] };
		});
		const el = await pane(proposal());
		await press(button(el, 'Accept'));
		expect(w.toasts.map((t) => [t.kind, t.title, t.message])).toEqual([['error', 'The proposal was not applied', 'The file changed since the proposal was made.']]);
		expect(ai.proposal()).toBeNull();
	});

	test('Discard drops it and writes nothing', async () => {
		const el = await pane(proposal());
		await press(button(el, 'Discard'));
		expect(ai.proposal()).toBeNull();
		expect(w.sent('ai_resolution_apply')).toEqual([]);
		expect(read(el)).toBe('');
	});

	test('while it is being written it cannot be discarded', async () => {
		const el = await pane(proposal({ state: 'applying' }));
		expect(disabled(button(el, 'Discard'))).toBe(true);
	});

	test('while Claude works it says the file is not touched, and Stop ends it', async () => {
		const el = await pane(proposal({ state: 'reading', conflicts: 0, diff: null, text: '', summary: '' }));
		expect(read(el)).toContain('Reading the conflicts…');
		expect(read(el)).toContain('The file is not touched while this runs.');
		ai.proposal.set(proposal({ state: 'running', conflicts: 2, diff: null, text: '', summary: '' }));
		await settle();
		expect(read(el)).toContain('Claude is working out a resolution for 2 conflicts…');
		expect(button(el, 'Accept')).toBeNull();
		await press(button(el, 'Stop'));
		expect(ai.proposal()).toBeNull();
		expect(w.sent('ai_resolution_apply')).toEqual([]);
	});
});

describe('asking for one', () => {
	const conflicted = { path: PATH, oldPath: null, status: 'conflicted' as const };

	test('reads the conflicted file, asks Claude with no tools, and previews the answer without writing it', async () => {
		w.on('ai_conflict_file', () => ({ text: `import x;\n${ORIGINAL}tail\n`, binary: false, tooLarge: false }));
		w.on('agent_start', (args) => {
			queueMicrotask(() => {
				w.emit('agent-event', { key: args.key, event: { type: 'result', subtype: 'success', is_error: false, result: 'Took both.\n<resolution conflict="1">\nboth\n</resolution>', total_cost_usd: 0.001 } });
				w.emit('agent-done', { key: args.key, ok: true, error: '' });
			});
		});
		const el = await pane(null);
		await ai.proposeResolution(conflicted);
		await settle();
		expect(w.sent('agent_start')[0].args.options).toMatchObject({ quick: true, tools: [] });
		// Only the conflict block changed: what is outside it is as it was.
		const preview = w.sent('ai_resolution_preview');
		expect(preview.length).toBe(1);
		expect(preview[0].args).toMatchObject({ id: REPO, path: PATH });
		expect(String(preview[0].args.text).startsWith('import x;\n')).toBe(true);
		expect(String(preview[0].args.text).endsWith('tail\n')).toBe(true);
		expect(String(preview[0].args.text)).not.toContain('<<<<<<<');
		expect(w.sent('ai_resolution_apply')).toEqual([]);
		expect(ai.proposal()).toMatchObject({ state: 'ready', conflicts: 1 });
		expect(read(el)).toContain('Proposed resolution for 1 conflict');
	});

	test('a file with no conflict markers gets no proposal, and says why', async () => {
		w.on('ai_conflict_file', () => ({ text: 'no markers here\n', binary: false, tooLarge: false }));
		await pane(null);
		await ai.proposeResolution(conflicted);
		expect(ai.proposal()).toBeNull();
		expect(w.sent('agent_start')).toEqual([]);
		expect(w.toasts[0]).toMatchObject({ kind: 'error', title: 'No resolution was proposed' });
		expect(w.toasts[0].message).toContain('This file has no conflict markers');
	});

	test('a binary file is not sent to Claude', async () => {
		w.on('ai_conflict_file', () => ({ text: '', binary: true, tooLarge: false }));
		await pane(null);
		await ai.proposeResolution(conflicted);
		expect(w.sent('agent_start')).toEqual([]);
		expect(w.toasts[0].message).toBe('This is a binary file. Choose your version or theirs instead.');
	});
});
