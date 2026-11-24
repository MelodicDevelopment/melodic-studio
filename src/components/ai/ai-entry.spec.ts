import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find } from '../../test/dom';
import { parseDiff } from '../../shared/diff';
import type { AiFeaturesStore } from '../../services/ai-features.store';
import type { RepoStore } from '../../services/repo.store';
import type { Commit, FileChange } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';

let w: World;
let repos: RepoStore;
let ai: AiFeaturesStore;
let entry: typeof import('./ai-entry');
let render: typeof import('@melodicdev/core/template').render;

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
	// The hooks, and the renderer of this test's own copy of Melodic.
	entry = await import('./ai-entry');
	({ render } = await import('@melodicdev/core/template'));
	await settle();
	w.on('agent_start', () => undefined);
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

/** What a hook hands back, put on the page the way the app's templates place it. */
async function place(part: unknown): Promise<HTMLElement> {
	const { html } = await import('@melodicdev/core/template');
	const box = document.createElement('div');
	document.body.append(box);
	render(html`${part}`, box);
	await settle();
	return box;
}

const QUEUE: FileChange = { path: 'src/player/queue.ts', oldPath: null, status: 'modified' };
const CONFLICT: FileChange = { path: 'src/player/shuffle.ts', oldPath: null, status: 'conflicted' };
const COMMIT: Commit = { hash: 'a1b2c3d'.padEnd(40, '0'), shortHash: 'a1b2c3d', authorName: 'A', authorEmail: 'a@example.com', date: '2026-11-20T10:00:00Z', parents: [], refs: [], summary: 'Wrap the queue', body: '', unpushed: true };

describe('nothing()', () => {
	test('is not an empty template: a root that renders it first still shows what comes later', async () => {
		const { html } = await import('@melodicdev/core/template');
		const box = document.createElement('div');
		document.body.append(box);
		render(entry.nothing(), box);
		expect(box.children.length).toBe(1);
		expect((box.firstElementChild as HTMLElement).hidden).toBe(true);
		expect(read(box)).toBe('');
		render(html`<p>Now there is something</p>`, box);
		expect(read(box)).toBe('Now there is something');
	});
});

describe('Explain', () => {
	test('on a file starts an explanation of that file’s diff, in the side panel', async () => {
		const box = await place(entry.explainButton({ kind: 'file', file: QUEUE }));
		expect(read(box)).toBe('Explain');
		await press(button(box, 'Explain'));
		expect(w.sent('ai_selected_diff').map((c) => c.args.files)).toEqual([[QUEUE]]);
		expect(ai.explanation()).toMatchObject({ title: 'queue.ts', detail: 'src/player/queue.ts', state: 'running' });
		expect(ai.panelOpen()).toBe(true);
	});

	test('on a commit explains that commit', async () => {
		const box = await place(entry.explainButton({ kind: 'commit', commit: COMMIT }));
		await press(button(box, 'Explain'));
		expect(w.sent('ai_commit_patch').map((c) => c.args)).toEqual([{ id: REPO, hash: COMMIT.hash }]);
		expect(ai.explanation()).toMatchObject({ title: 'Commit a1b2c3d', detail: 'Wrap the queue' });
	});

	test('is busy only for the thing being explained', async () => {
		ai.explanation.set({ target: { kind: 'file', file: QUEUE }, title: 'queue.ts', detail: QUEUE.path, state: 'running', text: '', error: '' });
		const same = await place(entry.explainButton({ kind: 'file', file: QUEUE }));
		const other = await place(entry.explainButton({ kind: 'file', file: { ...QUEUE, path: 'src/other.ts' } }));
		const commit = await place(entry.explainButton({ kind: 'commit', commit: COMMIT }));
		expect([same, other, commit].map((b) => find(b, 'ml-button')!.hasAttribute('loading'))).toEqual([true, false, false]);
	});

	test('without Claude Code it is off and says what to install', async () => {
		ai.cli.set(null);
		const box = await place(entry.explainButton({ kind: 'file', file: QUEUE }));
		const explain = find(box, 'ml-button')!;
		expect(disabled(explain)).toBe(true);
		expect(explain.title).toContain('Claude Code (the `claude` command) was not found on this computer.');
	});
});

describe('a conflicted file', () => {
	test('gets "Propose a resolution" instead of Explain, and says nothing is written until it is accepted', async () => {
		const box = await place(entry.fileAction(CONFLICT));
		expect(read(box)).toBe('Propose a resolution');
		expect(find(box, 'ml-button')!.title).toBe('Ask Claude for a resolution. Nothing is written until you accept it.');
		const plain = await place(entry.fileAction(QUEUE));
		expect(read(plain)).toBe('Explain');
	});

	test('the button asks for a proposal for that file, and writes nothing', async () => {
		const box = await place(entry.fileAction(CONFLICT));
		await press(button(box, 'Propose a resolution'));
		expect(w.sent('ai_conflict_file').map((c) => c.args)).toEqual([{ id: REPO, path: CONFLICT.path }]);
		expect(ai.proposal()).toMatchObject({ path: CONFLICT.path });
		expect(w.sent('ai_resolution_apply')).toEqual([]);
	});

	test('cannot be asked for twice while a proposal for it exists', async () => {
		ai.proposal.set({ path: CONFLICT.path, root: REPO, state: 'running', conflicts: 1, original: '', text: '', summary: '', diff: null });
		const box = await place(entry.fileAction(CONFLICT));
		expect(disabled(find(box, 'ml-button'))).toBe(true);
	});

	test('the same is a row of the file’s right-click menu', async () => {
		const box = await place(entry.proposeMenuItem(CONFLICT));
		expect(read(box)).toBe('Propose a resolution');
		await click(box.firstElementChild);
		expect(w.sent('ai_conflict_file').length).toBe(1);
	});

	test('its diff gives way to the proposal while there is one for it, and only for it', async () => {
		expect(entry.proposalPane(CONFLICT)).toBeNull();
		ai.proposal.set({ path: CONFLICT.path, root: REPO, state: 'ready', conflicts: 1, original: '', text: '', summary: '', diff: parseDiff('') });
		expect(entry.proposalPane(QUEUE)).toBeNull();
		const box = await place(entry.proposalPane(CONFLICT));
		expect(find(box, 'ms-ai-proposal')).not.toBeNull();
	});
});

describe('the panes', () => {
	test('the main pane is taken over only while a review finding is open', async () => {
		expect(entry.reviewPane()).toBeNull();
		ai.reviewView.set({ path: QUEUE.path, line: 17, diff: null });
		const box = await place(entry.reviewPane());
		expect(find(box, 'ms-ai-review-diff')).not.toBeNull();
	});

	test('the side panel is there with an explanation or a review, on Changes and History only', async () => {
		const empty = await place(entry.aiSidePanel());
		expect(all(empty, 'ms-ai-panel')).toEqual([]);
		ai.explanation.set({ target: { kind: 'file', file: QUEUE }, title: 'queue.ts', detail: QUEUE.path, state: 'done', text: 'It wraps.', error: '' });
		const shown = await place(entry.aiSidePanel());
		expect(all(shown, 'ms-ai-panel').length).toBe(1);
		repos.setTab('history');
		expect(all(await place(entry.aiSidePanel()), 'ms-ai-panel').length).toBe(1);
		repos.setTab('agents');
		expect(all(await place(entry.aiSidePanel()), 'ms-ai-panel')).toEqual([]);
		repos.setTab('files');
		expect(all(await place(entry.aiSidePanel()), 'ms-ai-panel')).toEqual([]);
	});
});

describe('the cards of "No local changes"', () => {
	const pushed = (over: object): void => repos.status.set({ ...repos.status()!, branch: 'feature/repeat-mode', detached: false, hasCommits: true, upstream: 'origin/feature/repeat-mode', ahead: 0, defaultBranch: 'main', files: [], undo: null, ...over });

	test('are one for each thing Claude can review, saying what it would look at', async () => {
		pushed({ ahead: 2 });
		const box = await place(entry.reviewCard());
		expect(all(box, 'button').map((b) => read(b))).toEqual([
			'Review before pushing Claude looks for bugs and risks in 2 unpushed commits',
			'Review this branch Claude looks for bugs and risks in everything feature/repeat-mode adds to main: what its pull request carries',
		]);
	});

	test('are still there after a push: the branch can be reviewed', async () => {
		pushed({});
		const box = await place(entry.reviewCard());
		expect(all(box, 'button').map((b) => read(b).split(' Claude')[0])).toEqual(['Review this branch']);
	});

	test('a click starts that review', async () => {
		pushed({ ahead: 2 });
		const box = await place(entry.reviewCard());
		await click(all(box, 'button')[1]);
		expect(w.sent('ai_review_diff').map((c) => c.args)).toEqual([{ id: REPO, scope: 'branch', base: null }]);
	});

	test('are none where there is nothing to review', async () => {
		pushed({ branch: 'main', upstream: 'origin/main' });
		const box = await place(entry.reviewCard());
		expect(all(box, 'button')).toEqual([]);
	});

	test('are off while a push is going, and without Claude Code', async () => {
		pushed({ ahead: 2 });
		repos.busy.set('push');
		const pushing = await place(entry.reviewCard());
		expect(all<HTMLButtonElement>(pushing, 'button').map((b) => b.disabled)).toEqual([true, true]);
		repos.busy.set('');
		ai.cli.set(null);
		const off = await place(entry.reviewCard());
		expect(all<HTMLButtonElement>(off, 'button').map((b) => b.disabled)).toEqual([true, true]);
		expect(all(off, 'button')[0].title).toContain('was not found on this computer');
	});
});
