import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import { parseDiff, type DiffNote } from '../../shared/diff';
import type { AiFeaturesStore, ReviewState } from '../../services/ai-features.store';
import type { Finding } from '../../services/ai-prompts';
import type { RepoStore } from '../../services/repo.store';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const PATH = 'src/player/queue.ts';
const DIFF = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -16,3 +16,4 @@\n context\n-old line\n+new line seventeen\n+new line eighteen\n context\n`;

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
	ai.init();
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

const BUG: Finding = { file: PATH, line: 17, severity: 'bug', title: 'next() no longer advances past the last track', detail: 'previous() relied on that.' };
const RISK: Finding = { file: PATH, line: null, severity: 'risk', title: 'The file has no tests', detail: '' };
const ELSEWHERE: Finding = { file: 'src/player/repeat.ts', line: 3, severity: 'nit', title: 'In another file', detail: '' };

function review(over: Partial<ReviewState> = {}): ReviewState {
	return {
		state: 'done',
		request: { scope: 'push' },
		range: { scope: 'push', truncated: false, base: 'b'.repeat(40), head: 'c'.repeat(40), against: 'origin/main', commits: [{ hash: 'c'.repeat(40), summary: 'One' }, { hash: 'd'.repeat(40), summary: 'Two' }, { hash: 'e'.repeat(40), summary: 'Three' }], files: [{ path: PATH, oldPath: null, status: 'modified' }] },
		summary: '',
		findings: [BUG, RISK, ELSEWHERE],
		error: '',
		raw: '',
		progress: '',
		...over,
	};
}

/** The main pane while a finding is open: that file's diff over what was reviewed. */
async function pane(rv: ReviewState | null, line: number | null = 17): Promise<HTMLElement> {
	ai.reviewed.set(rv);
	ai.reviewView.set(rv ? { path: PATH, line, diff: parseDiff(DIFF) } : null);
	return mount('ms-ai-review-diff');
}

const diffView = (el: HTMLElement): HTMLElement & { notes: DiffNote[]; focusLine: number | null; diff: unknown } => find(el, 'ms-diff')!;

describe('a finding opened in the main pane', () => {
	test('shows nothing until one is opened, and then the file it is in', async () => {
		const el = await pane(null);
		expect(read(el)).toBe('');
		ai.reviewed.set(review());
		ai.reviewView.set({ path: PATH, line: 17, diff: parseDiff(DIFF) });
		await settle();
		expect(read(el)).toContain('src/player/ queue.ts');
	});

	test('names the file and says how many findings it has, over what was reviewed', async () => {
		const el = await pane(review());
		expect(read(find(el, '.head')!)).toBe('src/player/ queue.ts 2 findings in 3 unpushed commits Close');
		ai.reviewed.set(review({ request: { scope: 'branch' } }));
		await settle();
		expect(read(find(el, '.head')!)).toContain('2 findings in 3 commits');
		ai.reviewed.set(review({ request: { scope: 'work' } }));
		await settle();
		expect(read(find(el, '.head')!)).toContain('2 findings in the reviewed changes');
	});

	test('puts this file’s findings in the diff at their lines, the clicked one in view, and leaves other files’ out', async () => {
		const el = await pane(review());
		const view = diffView(el);
		expect(view.focusLine).toBe(17);
		expect(view.notes.map((n) => [n.line, n.label, n.title])).toEqual([
			[17, 'bug', BUG.title],
			[null, 'risk', RISK.title],
		]);
		const shown = read(view);
		expect(shown).toContain(BUG.title);
		expect(shown).toContain('previous() relied on that.');
		expect(shown).toContain(RISK.title);
		expect(shown).not.toContain(ELSEWHERE.title);
		// The finding sits under the line it names.
		expect(shown.indexOf('new line seventeen')).toBeLessThan(shown.indexOf(BUG.title));
		expect(shown.indexOf(BUG.title)).toBeLessThan(shown.indexOf('new line eighteen'));
	});

	test('a finding in the diff can be handed to an agent from there', async () => {
		const el = await pane(review());
		const [note] = diffView(el).notes;
		expect(note.action).toMatchObject({ label: 'Ask Claude to fix', disabled: false });
		await press(button(find(diffView(el), '[data-line="17"]')!, 'Ask Claude to fix'));
		expect(w.sent('agent_start').length).toBe(1);
		expect(String(w.sent('agent_start')[0].args.prompt)).toContain(BUG.title);
		expect(ai.fixSent().has(BUG)).toBe(true);
	});

	test('a finding’s words are text in the diff too', async () => {
		const nasty: Finding = { file: PATH, line: 17, severity: 'bug', title: '<img src=x onerror=alert(1)>', detail: '<script>alert(2)</script>' };
		const el = await pane(review({ findings: [nasty] }));
		expect(all(el, 'img, script').length).toBe(0);
		expect(read(diffView(el))).toContain('<img src=x onerror=alert(1)>');
	});

	test('while the diff loads the pane is there, and the diff arrives', async () => {
		ai.reviewed.set(review());
		ai.reviewView.set({ path: PATH, line: 17, diff: null });
		const el = await mount('ms-ai-review-diff');
		expect(diffView(el).diff).toBeNull();
		ai.reviewView.set({ path: PATH, line: 17, diff: parseDiff(DIFF) });
		await settle();
		expect(read(diffView(el))).toContain('new line seventeen');
	});

	test('Close and the back arrow go back to what was on screen; the review stays', async () => {
		const el = await pane(review());
		await press(button(el, 'Close'));
		expect(ai.reviewView()).toBeNull();
		expect(ai.reviewed()).not.toBeNull();
		expect(read(el)).toBe('');
		ai.reviewView.set({ path: PATH, line: 17, diff: parseDiff(DIFF) });
		await settle();
		await click(find(el, 'button[title="Back to what you were looking at"]'));
		expect(ai.reviewView()).toBeNull();
	});

	test('picking another file or tab takes the main pane back', async () => {
		await pane(review());
		repos.setTab('history');
		await settle();
		expect(ai.reviewView()).toBeNull();
	});
});
