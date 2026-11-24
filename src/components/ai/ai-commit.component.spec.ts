import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AiFeaturesStore } from '../../services/ai-features.store';
import type { RepoStore } from '../../services/repo.store';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

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

/** Claude's answer to the next one-shot question, given at once (the demo's own takes half a second). */
function answers(text: string): void {
	w.on('agent_start', (args) => {
		queueMicrotask(() => {
			w.emit('agent-event', { key: args.key, event: { type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001 } });
			w.emit('agent-done', { key: args.key, ok: true, error: '' });
		});
	});
}

/** The sparkle in the Summary field. */
const sparkle = (el: HTMLElement): HTMLButtonElement => find<HTMLButtonElement>(el, 'button')!;
const uncheckAll = (): void => repos.excluded.set(new Set(repos.status()!.files.map((f) => f.path)));

describe('the sparkle in the commit form', () => {
	test('says what it does, and is off until a file is checked', async () => {
		const el = await mount('ms-ai-commit-button');
		expect(sparkle(el).disabled).toBe(false);
		expect(sparkle(el).getAttribute('aria-label')).toBe('Write the summary and description from the checked files');
		uncheckAll();
		await settle();
		expect(sparkle(el).disabled).toBe(true);
		expect(sparkle(el).getAttribute('aria-label')).toBe('Check the files to commit, then let Claude write the message');
	});

	test('without Claude Code it is off and says what to install', async () => {
		const el = await mount('ms-ai-commit-button');
		ai.cli.set(null);
		await settle();
		expect(sparkle(el).disabled).toBe(true);
		expect(sparkle(el).getAttribute('aria-label')).toContain('Claude Code (the `claude` command) was not found on this computer.');
	});

	test('fills an empty form from the checked files alone, and asks Claude with no tools', async () => {
		answers(JSON.stringify({ summary: 'Wrap the queue when repeat is on', description: '- next() takes a repeat flag' }));
		const [first, ...rest] = repos.status()!.files;
		repos.excluded.set(new Set(rest.map((f) => f.path)));
		const el = await mount('ms-ai-commit-button');
		await click(sparkle(el));
		expect(w.sent('ai_selected_diff').map((c) => c.args.files)).toEqual([[first]]);
		expect(w.sent('agent_start')[0].args.options).toMatchObject({ quick: true, tools: [] });
		expect(repos.summary()).toBe('Wrap the queue when repeat is on');
		expect(repos.description()).toBe('- next() takes a repeat flag');
		expect(ai.suggestion()).toBeNull();
		expect(ai.writing()).toBe(false);
	});

	test('while it writes it shows that, and a second click stops it without writing anything', async () => {
		w.on('agent_start', () => undefined);
		const el = await mount('ms-ai-commit-button');
		await click(sparkle(el));
		expect(find(el, 'ml-spinner')).not.toBeNull();
		expect(sparkle(el).getAttribute('aria-label')).toBe('Stop writing the commit message');
		await click(sparkle(el));
		expect(ai.writing()).toBe(false);
		expect(find(el, 'ml-spinner')).toBeNull();
		expect(repos.summary()).toBe('');
		expect(w.toasts.map((t) => t.title)).toEqual(['Stopped']);
	});

	test('can still be stopped when the last file is unchecked while it writes', async () => {
		w.on('agent_start', () => undefined);
		const el = await mount('ms-ai-commit-button');
		await click(sparkle(el));
		uncheckAll();
		await settle();
		expect(sparkle(el).disabled).toBe(false);
	});

	test('an answer that is no commit message is said, and the form is left alone', async () => {
		answers('{"findings": []}');
		const el = await mount('ms-ai-commit-button');
		await click(sparkle(el));
		expect(repos.summary()).toBe('');
		expect(w.toasts.map((t) => [t.kind, t.title])).toEqual([['error', 'Could not write a commit message']]);
	});
});

describe('a suggested message', () => {
	test('text the user typed is never replaced: the answer is offered beside it', async () => {
		answers(JSON.stringify({ summary: 'Wrap the queue when repeat is on', description: '- next() takes a repeat flag' }));
		repos.summary.set('wip queue');
		const button_ = await mount('ms-ai-commit-button');
		const el = await mount('ms-ai-commit-suggestion');
		expect(read(el)).toBe('');
		await click(sparkle(button_));
		expect(repos.summary()).toBe('wip queue');
		expect(read(el)).toBe('Suggested message Wrap the queue when repeat is on - next() takes a repeat flag Replace mine Dismiss');
	});

	test('Replace mine takes it into the form', async () => {
		repos.summary.set('wip queue');
		repos.description.set('notes to self');
		const el = await mount('ms-ai-commit-suggestion');
		ai.suggestion.set({ summary: 'Wrap the queue when repeat is on', description: '' });
		await settle();
		await press(button(el, 'Replace mine'));
		expect(repos.summary()).toBe('Wrap the queue when repeat is on');
		expect(repos.description()).toBe('');
		expect(read(el)).toBe('');
	});

	test('Dismiss drops it and keeps what was typed', async () => {
		repos.summary.set('wip queue');
		ai.suggestion.set({ summary: 'Wrap the queue when repeat is on', description: 'More.' });
		const el = await mount('ms-ai-commit-suggestion');
		await press(button(el, 'Dismiss'));
		expect(ai.suggestion()).toBeNull();
		expect(repos.summary()).toBe('wip queue');
		expect(read(el)).toBe('');
	});

	test('is shown as text', async () => {
		ai.suggestion.set({ summary: '<img src=x onerror=alert(1)>', description: '<script>alert(2)</script>' });
		const el = await mount('ms-ai-commit-suggestion');
		expect(all(el, 'img, script').length).toBe(0);
		expect(read(el)).toContain('<img src=x onerror=alert(1)> <script>alert(2)</script>');
	});

	test('an answer the same as what was typed is not offered back', async () => {
		answers(JSON.stringify({ summary: 'Wrap the queue', description: '' }));
		repos.summary.set('Wrap the queue');
		const button_ = await mount('ms-ai-commit-button');
		const el = await mount('ms-ai-commit-suggestion');
		await click(sparkle(button_));
		expect(ai.suggestion()).toBeNull();
		expect(read(el)).toBe('');
	});
});
