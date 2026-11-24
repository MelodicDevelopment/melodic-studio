import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world } from '../../test/world';
import { find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { LspService, ServerWork } from '../../services/lsp.service';

// Monaco cannot run in happy-dom, and the language services reach for it as soon as the status changes.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

const HARMONY = '/Users/demo/Source/harmony';

let repos: RepoStore;
let lsp: LspService;

/**
 * happy-dom keeps its custom elements across `vi.resetModules()` and Melodic defines a tag only once, so
 * without this every test after the first would mount the first test's classes, bound to its stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const value = registry[key];
		if (value instanceof Map) {
			value.clear();
		}
	}
}

/**
 * What a person reads under `root`, through shadow roots: the text as it is written, a space where an element
 * starts or ends, and no icons (an `ml-icon` draws a private-use character of its font).
 */
function words(root: Node): string {
	let out = '';
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.textContent ?? '';
			return;
		}
		if (node instanceof Element) {
			if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') {
				return;
			}
			if (node.shadowRoot) {
				walk(node.shadowRoot);
			}
		}
		out += ' ';
		node.childNodes.forEach(walk);
		out += ' ';
	};
	walk(root);
	return out.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}

beforeEach(async () => {
	const w = await world();
	forgetElements();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	lsp = w.get((await import('../../services/lsp.service')).LspService);
	await repos.init();
});

/** What a server says it is doing, as its `$/progress` reports become. */
function work(change: Partial<ServerWork> = {}): ServerWork {
	return { root: HARMONY, label: 'Rust', title: 'Indexing', message: '', percentage: null, ...change };
}

async function status(working: Record<string, ServerWork>): Promise<HTMLElement> {
	lsp.working.set(working);
	const el = await mount('ms-lsp-status');
	await settle();
	return el;
}

describe('the language server status', () => {
	test('is not there while no server reports work', async () => {
		const el = await status({});
		expect(find(el, '.status')).toBeNull();
		expect(words(el)).toBe('');
	});

	test('names the server and what it is doing, with how far it is', async () => {
		const el = await status({ 'rust-analyzer@1|a': work({ percentage: 41.6 }) });
		expect(find(el, '.text')!.textContent).toBe('Rust: Indexing 42%');
		expect(find(el, 'ml-spinner')).not.toBeNull();
		expect(find(el, '.status')!.title).toBe('The Rust language server is still working. Suggestions and errors may be incomplete until it is done.');
	});

	test('adds the server\'s own detail, and leaves the percentage out when there is none', async () => {
		const el = await status({ k: work({ label: 'C#', title: 'Loading', message: 'Api.sln' }) });
		expect(find(el, '.text')!.textContent).toBe('C#: Loading Api.sln');
	});

	test('a server that says nothing about its work is still named', async () => {
		const el = await status({ k: work({ label: 'TypeScript', title: '', message: '' }) });
		expect(find(el, '.text')!.textContent).toBe('TypeScript');
	});

	test('zero percent is a percentage', async () => {
		const el = await status({ k: work({ percentage: 0 }) });
		expect(find(el, '.text')!.textContent).toBe('Rust: Indexing 0%');
	});

	test('work in another checkout is not this one\'s', async () => {
		const el = await status({ k: work({ root: '/Users/demo/Source/harmony.worktrees/agent-fix' }) });
		expect(find(el, '.status')).toBeNull();
	});

	test('it appears when work starts and goes when it ends', async () => {
		const el = await status({});
		lsp.working.set({ k: work() });
		await settle();
		expect(find(el, '.text')!.textContent).toBe('Rust: Indexing');
		lsp.working.set({});
		await settle();
		expect(find(el, '.status')).toBeNull();
	});

	test('the server\'s words are shown as text', async () => {
		const el = await status({ k: work({ title: '<img src=x onerror="window.pwned = true">' }) });
		expect(find(el, '.text')!.textContent).toBe('Rust: <img src=x onerror="window.pwned = true">');
		expect(find(el, 'img')).toBeNull();
	});
});
