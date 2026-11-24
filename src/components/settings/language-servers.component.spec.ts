import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { LspService } from '../../services/lsp.service';
import type { AgentsStore } from '../../services/agents.store';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let lsp: LspService;
let agents: AgentsStore;

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

/** happy-dom has no Popover API (an `ml-select` closes its list through it). */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	proto.showPopover = proto.hidePopover = proto.togglePopover = function () {};
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
	w = await world();
	forgetElements();
	popovers();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	lsp = w.get((await import('../../services/lsp.service')).LspService);
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await repos.init();
});

/** The section inside a dialog, as Settings holds it, with the dialog just opened. */
async function section(): Promise<{ el: HTMLElement; dialog: HTMLElement }> {
	const dialog = document.createElement('ml-dialog');
	const el = document.createElement('ms-language-servers');
	dialog.append(el);
	document.body.append(dialog);
	await settle();
	dialog.dispatchEvent(new CustomEvent('ml:open'));
	await settle();
	return { el, dialog };
}

function row(el: Element, label: string): HTMLElement {
	return all(el, '.row').find((r) => find(r, '.name')?.textContent === label)!;
}

function buttons(el: Element, label: string): string[] {
	return all(row(el, label), 'ml-button').map((b) => words(b));
}

async function press(el: Element, label: string, button: string): Promise<void> {
	await click(find(all(row(el, label), 'ml-button').find((b) => words(b) === button)!, 'button'));
}

describe('looking', () => {
	test('nothing is looked for until Settings opens; then every time it does', async () => {
		const dialog = document.createElement('ml-dialog');
		const el = document.createElement('ms-language-servers');
		dialog.append(el);
		document.body.append(dialog);
		await settle();
		expect(w.sent('lsp_servers')).toEqual([]);
		expect(find(el, '.row ml-spinner')).not.toBeNull();

		dialog.dispatchEvent(new CustomEvent('ml:open'));
		await settle();
		expect(w.sent('lsp_servers').length).toBe(1);
		expect(w.sent('lsp_servers')[0].args.id).toBe(repos.repo()!.id);
		expect(all(el, '.row .name').map((n) => n.textContent)).toEqual(['TypeScript and JavaScript', 'PHP', 'C#', 'Rust']);

		dialog.dispatchEvent(new CustomEvent('ml:open'));
		await settle();
		expect(w.sent('lsp_servers').length).toBe(2);
	});

	test('says where servers come from, and that nothing is installed system-wide', async () => {
		const { el } = await section();
		expect(words(find(el, 'p')!)).toBe("Hover, go to definition and errors in the Files tab. A project's own copy is used first; otherwise Melodic Studio installs one into its own folder, never system-wide.");
	});
});

describe('a server\'s row', () => {
	test('a project\'s own copy is said to be that, with its version, and needs no button', async () => {
		const { el } = await section();
		const status = find(row(el, 'TypeScript and JavaScript'), '.status')!;
		expect(words(status)).toBe("This project's own copy: typescript-language-server 6.1.0");
		expect(status.classList.contains('ok')).toBe(true);
		expect(find(status, 'span')!.title).toBe('/Users/demo/Source/harmony/node_modules/.bin/typescript-language-server');
		expect(buttons(el, 'TypeScript and JavaScript')).toEqual([]);
	});

	test('a server that is not installed can be installed, and then removed', async () => {
		const { el } = await section();
		expect(words(find(row(el, 'PHP'), '.status')!)).toBe('Not installed');
		expect(buttons(el, 'PHP')).toEqual(['Install']);

		await press(el, 'PHP', 'Install');
		expect(w.sent('lsp_install').map((c) => c.args.name)).toEqual(['php']);
		expect(words(find(row(el, 'PHP'), '.status')!)).toBe('Installed by Melodic Studio: intelephense 1.0.0');
		expect(buttons(el, 'PHP')).toEqual(['Remove']);

		await press(el, 'PHP', 'Remove');
		expect(w.sent('lsp_uninstall').map((c) => c.args.name)).toEqual(['php']);
		expect(words(find(row(el, 'PHP'), '.status')!)).toBe('Not installed');
		expect(buttons(el, 'PHP')).toEqual(['Install']);
	});

	test('while it installs the row says so, and a second click does not install twice', async () => {
		let done: () => void = () => {};
		w.on('lsp_install', () => new Promise<void>((resolve) => (done = resolve)));
		const { el } = await section();
		await press(el, 'PHP', 'Install');
		expect(words(find(row(el, 'PHP'), '.status span')!)).toBe('Installing intelephense. This can take a minute.');
		// The button is busy now, so it no longer reads "Install" alone.
		await click(find(all(row(el, 'PHP'), 'ml-button')[0], 'button'));
		expect(w.sent('lsp_install').length).toBe(1);
		done();
		await settle();
		expect(words(find(row(el, 'PHP'), '.status')!)).not.toContain('Installing');
	});

	test('an install that fails shows what the installer said', async () => {
		w.on('lsp_install', () => {
			throw appError('error', 'npm ERR! code E404\nnpm ERR! 404 Not Found');
		});
		const { el } = await section();
		await press(el, 'PHP', 'Install');
		expect(find(row(el, 'PHP'), '.trouble.output')!.textContent).toBe('npm ERR! code E404\nnpm ERR! 404 Not Found');
		expect(buttons(el, 'PHP')).toEqual(['Install']);
	});

	test('when what the install needs is missing, Install is off and the row says what to get', async () => {
		const { el } = await section();
		expect(words(find(row(el, 'C#'), '.hint')!)).toBe('Installing it needs the .NET SDK, which was not found on this computer.');
		expect(find<HTMLButtonElement>(all(row(el, 'C#'), 'ml-button')[0], 'button')!.disabled).toBe(true);
		await press(el, 'C#', 'Install');
		expect(w.sent('lsp_install')).toEqual([]);
	});

	test('a copy on PATH that does not run says why, and how to install a real one', async () => {
		const { el } = await section();
		const rust = row(el, 'Rust');
		expect(words(find(rust, '.status')!)).toBe('Found on your PATH: rust-analyzer');
		expect(find(rust, '.status')!.classList.contains('bad')).toBe(true);
		expect(words(find(rust, '.trouble')!)).toBe("It does not run: error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.");
		expect(words(find(rust, '.hint')!)).toBe('Install it with rustup component add rust-analyzer');
		expect(buttons(el, 'Rust')).toEqual([]);
	});

	test('a server that stopped says why, and Restart tries again', async () => {
		const { el } = await section();
		lsp.failures.set({ typescript: 'It exited: Cannot find module typescript' });
		await settle();
		const ts = row(el, 'TypeScript and JavaScript');
		expect(words(find(ts, '.trouble')!)).toBe('It is not running: It exited: Cannot find module typescript');
		expect(find(ts, '.status')!.classList.contains('bad')).toBe(true);
		// A project's own copy that will not stay up can be replaced by one Studio installs.
		expect(buttons(el, 'TypeScript and JavaScript')).toEqual(['Restart', 'Install']);

		const before = w.sent('lsp_servers').length;
		await press(el, 'TypeScript and JavaScript', 'Restart');
		expect(lsp.failures()).toEqual({});
		expect(w.sent('lsp_servers').length).toBe(before + 1);
		expect(find(row(el, 'TypeScript and JavaScript'), '.trouble')).toBeNull();
		expect(buttons(el, 'TypeScript and JavaScript')).toEqual([]);
	});

	test('what a server printed is shown as text', async () => {
		w.on('lsp_install', () => {
			throw appError('error', '<img src=x onerror="window.pwned = true">');
		});
		const { el } = await section();
		await press(el, 'PHP', 'Install');
		expect(find(row(el, 'PHP'), '.trouble.output')!.textContent).toBe('<img src=x onerror="window.pwned = true">');
		expect(find(el, 'img')).toBeNull();
	});
});

describe('checking an agent\'s changes', () => {
	// A bug until 2026-11-23: the switch is an `<ml-toggle>` (language-servers.component.ts, the template's last element), and
	// nothing registers that element: src/components.ts imports no `@melodicdev/components/toggle`. An element nobody
	// defined draws nothing, so the label, the hint and the switch are not on screen and the setting cannot be changed
	// from Settings. What holds now: a switch that is on, and turning it off stops the checks. Before the fix: no switch.
	test('has a switch in this section, on to begin with, that turns the checks off', async () => {
		const { el } = await section();
		const input = find<HTMLInputElement>(find(el, 'ml-toggle')!, 'input')!;
		expect(input.checked).toBe(true);
		input.checked = false;
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(agents.checksOn()).toBe(false);
		expect(localStorage.getItem('studio.agents.check')).toBe('off');
	});

	test('the checks are on unless they were turned off', async () => {
		expect(agents.checksOn()).toBe(true);
		agents.setChecks(false);
		expect(localStorage.getItem('studio.agents.check')).toBe('off');
	});
});
