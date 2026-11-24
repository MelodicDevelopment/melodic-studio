import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { RunStore } from '../../services/run.store';
import type { RunTarget } from '../../services/backend.service';

// Monaco cannot run in happy-dom, and the language services reach for it as soon as the status changes.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
// xterm cannot run here either. A run is a tab of the terminal panel, so this stands in for the terminal it draws in.
vi.mock('../../shared/xterm', () => {
	class Terminal {
		cols = 80;
		rows = 24;
		options: Record<string, unknown> = {};
		loadAddon(): void {}
		open(): void {}
		write(): void {}
		focus(): void {}
		blur(): void {}
		dispose(): void {}
		onData(): void {}
		onResize(): void {}
		attachCustomKeyEventHandler(): void {}
		getSelection(): string {
			return '';
		}
	}
	class Addon {
		fit(): void {}
	}
	return { loadXterm: async () => ({ Terminal, FitAddon: Addon, WebLinksAddon: Addon }), adoptXtermStyles: () => {}, xtermTheme: () => ({}) };
});

let w: World;
let repos: RepoStore;
let run: RunStore;

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

/** happy-dom has no Popover API: these keep an `open` mark on the element and send the `toggle` event a browser does. */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	const set = (el: HTMLElement, open: boolean): void => {
		if (el.hasAttribute('data-open') !== open) {
			el.toggleAttribute('data-open', open);
			el.dispatchEvent(Object.assign(new Event('toggle'), { newState: open ? 'open' : 'closed', oldState: open ? 'closed' : 'open' }));
		}
	};
	proto.showPopover = function () {
		set(this, true);
	};
	proto.hidePopover = function () {
		set(this, false);
	};
	proto.togglePopover = function () {
		set(this, !this.hasAttribute('data-open'));
	};
}

beforeEach(async () => {
	w = await world();
	forgetElements();
	popovers();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	run = w.get((await import('../../services/run.store')).RunStore);
	await repos.init();
});

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

/** A target as `targets_list` answers them. */
function target(group: string, name: string, argv: string, kind: 'run' | 'test' = 'run'): RunTarget {
	return { id: `${group}::${name}`, name, group, cwd: '', argv: argv.split(' '), kind, runtime: 'node', source: 'package.json' };
}

/** Twelve targets in three projects: over the eight where the list gets a filter and folds. */
const MANY: RunTarget[] = [
	...['dev', 'build', 'lint', 'test'].map((n) => target('web', n, `npm run ${n}`)),
	...['dev', 'build', 'migrate', 'seed'].map((n) => target('api', n, `npm run ${n} --workspace api`)),
	...['storybook', 'build', 'docs', 'publish'].map((n) => target('ui', n, `npm run ${n} --workspace ui`)),
];

async function control(): Promise<HTMLElement> {
	const el = await mount('ms-run-control');
	await settle();
	return el;
}

async function many(): Promise<HTMLElement> {
	w.on('targets_list', () => MANY);
	// The demo backend only runs its own three targets.
	w.on('target_run', (args) => ({ key: `run-${String(args.target)}`, port: null, command: MANY.find((t) => t.id === args.target)!.argv.join(' ') }));
	return control();
}

/** The click goes to the popover's own trigger wrapper: happy-dom does not carry a click on slotted content through the slot. */
async function openList(el: Element): Promise<void> {
	await click(find(el, '#run-pop')!.shadowRoot!.querySelector('.ml-popover__trigger'));
}

function items(el: Element): string[] {
	return all(el, '.item').map((i) => words(find(i, '.what')!));
}

function item(el: Element, name: string, group?: string): HTMLElement {
	return all(el, '.item').find((i) => find(i, '.t')!.textContent === name && (!group || words(find(i, '.cmd')!).includes(group)))!;
}

function groups(el: Element): string[] {
	return all(el, '.group').map((g) => words(g));
}

async function type(el: Element, value: string): Promise<void> {
	const input = find<HTMLInputElement>(find(el, '.filter ml-input')!, 'input')!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

describe('with nothing to run', () => {
	test('the control is hidden until the targets are known', async () => {
		w.on('targets_list', () => new Promise(() => {}));
		const el = await control();
		expect(el.hasAttribute('hidden')).toBe(true);
		expect(find(el, '.run')).toBeNull();
	});

	test('a checkout with no targets has no control, and the divider after it goes with it', async () => {
		w.on('targets_list', () => []);
		const el = await control();
		expect(el.hasAttribute('hidden')).toBe(true);
		expect(find(el, '.run')).toBeNull();
		expect(find(el, '.rule')).toBeNull();
	});

	test('it looks again when the window comes back, since it cannot be opened to look', async () => {
		let found: RunTarget[] = [];
		w.on('targets_list', () => found);
		const el = await control();
		found = [target('package.json', 'dev', 'npm run dev')];
		const before = w.sent('targets_list').length;
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(w.sent('targets_list').length).toBe(before + 1);
		expect(el.hasAttribute('hidden')).toBe(false);
		expect(words(find(el, 'button.name')!)).toBe('dev');
	});

	test('with targets on screen the window coming back does not ask again', async () => {
		await control();
		const before = w.sent('targets_list').length;
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(w.sent('targets_list').length).toBe(before);
	});
});

describe('the control', () => {
	test('shows the target "run" usually means, not the first script', async () => {
		const el = await control();
		expect(el.hasAttribute('hidden')).toBe(false);
		expect(words(find(el, 'button.name')!)).toBe('dev');
		expect(find(el, 'button.name')!.title).toBe('npm run dev');
		expect(find(el, 'button.act')!.title).toBe('Run dev');
		expect(find(el, '.rule')).not.toBeNull();
	});

	test('lists every target under where it was found, with its command, the selected one marked', async () => {
		const el = await control();
		expect(groups(el)).toEqual(['package.json']);
		expect(find(el, '.group')!.title).toBe('Found in package.json');
		expect(items(el)).toEqual(['build npm run build', 'dev npm run dev', 'test npm test']);
		expect(all(el, '.item.current').map((i) => find(i, '.t')!.textContent)).toEqual(['dev']);
	});

	test('a short list has no filter and does not fold', async () => {
		const el = await control();
		expect(find(el, '.filter')).toBeNull();
		await click(find(el, '.group'));
		expect(items(el).length).toBe(3);
	});

	test('opening the list looks for targets again', async () => {
		const el = await control();
		const before = w.sent('targets_list').length;
		await openList(el);
		expect(w.sent('targets_list').length).toBe(before + 1);
	});

	test('picking a target selects it, remembers it for the repository, and does not run it', async () => {
		const el = await control();
		await openList(el);
		await click(item(el, 'build'));
		expect(words(find(el, 'button.name')!)).toBe('build');
		expect(JSON.parse(localStorage.getItem('studio.run.selected')!)).toEqual({ '/Users/demo/Source/harmony': 'node::build' });
		expect(w.sent('target_run')).toEqual([]);
		expect(find(el, '#run-pop')!.shadowRoot!.querySelector('.ml-popover__content')!.hasAttribute('data-open')).toBe(false);
	});

	test('a target of a named project shows the project with its name', async () => {
		w.on('targets_list', () => [target('Api · launchSettings.json', 'https', 'dotnet run --launch-profile https')]);
		const el = await control();
		expect(words(find(el, 'button.name')!)).toBe('Api · https');
	});

	test('in the toolbar, the control goes with a repository that has nothing to run and comes back with one that has', async () => {
		w.on('ci_runs', () => []);
		const bar = await mount('ms-toolbar');
		await settle();
		expect(find(bar, 'ms-run-control')!.hasAttribute('hidden')).toBe(false);
		await repos.selectRepo('/Users/demo/Source/cadence');
		await settle();
		expect(find(bar, 'ms-run-control')!.hasAttribute('hidden')).toBe(true);
		await repos.selectRepo('/Users/demo/Source/harmony');
		await settle();
		expect(find(bar, 'ms-run-control')!.hasAttribute('hidden')).toBe(false);
		expect(words(find(bar, 'ms-run-control button.name')!)).toBe('dev');
	});

	// A bug until 2026-11-23 (run-control.component.ts, onRender): the comment there says the repository and the status are
	// read "so a repository, worktree or branch switch renders again", but Melodic runs onRender untracked, so those
	// reads subscribe nothing. A repository or worktree switch still works, because the toolbar rebuilds the control
	// while the status is away. A branch checkout does not rebuild it. What holds now: the targets are read again for the
	// new branch (CLAUDE.md: "looks again when the checkout or its branch changes"). Before the fix: nothing is asked until
	// the list is opened, or, while the control is hidden, until the window gets the focus back.
	test('looks for targets again when the branch changes', async () => {
		await control();
		const before = w.sent('targets_list').length;
		const status = repos.status()!;
		w.on('repo_status', () => ({ ...status, branch: 'main', head: 'f'.repeat(40) }));
		await repos.refresh();
		await settle();
		expect(repos.status()!.branch).toBe('main');
		expect(w.sent('targets_list').length).toBe(before + 1);
	});
});

describe('running', () => {
	test('Run starts the selected target by its id: no command line comes from the window', async () => {
		const el = await control();
		await click(find(el, 'button.act'));
		expect(w.sent('target_run').length).toBe(1);
		expect(Object.keys(w.sent('target_run')[0].args).sort()).toEqual(['cols', 'id', 'rows', 'target']);
		expect(w.sent('target_run')[0].args).toMatchObject({ id: '/Users/demo/Source/harmony', target: 'node::dev' });
	});

	test('a run is a tab of the terminal panel, which opens', async () => {
		const el = await control();
		const { terminals } = await import('../../services/terminal.store');
		await click(find(el, 'button.act'));
		expect(terminals().tabs().map((t) => [t.title, t.kind])).toEqual([['dev', 'run']]);
		expect(terminals().open()).toBe(true);
	});

	test('while it runs there is Restart and Stop instead of Run, and the list says which one runs', async () => {
		const el = await control();
		await click(find(el, 'button.act'));
		expect(all(el, 'button.act').map((b) => b.title)).toEqual(['Restart', 'Stop']);
		expect(find(el, '.run')!.classList.contains('on')).toBe(true);
		expect(find(item(el, 'dev'), '.live')!.textContent).toBe('running');
		expect(find(item(el, 'dev'), '.go')!.title).toBe('Restart');
		expect(find(item(el, 'build'), '.live')).toBeNull();
		expect(find(item(el, 'build'), '.go')!.title).toBe('Run');
	});

	test('Stop ends the program and keeps its tab', async () => {
		const el = await control();
		const { terminals } = await import('../../services/terminal.store');
		await click(find(el, 'button.act'));
		const key = w.sent('target_run')[0];
		expect(key).toBeDefined();
		await click(find(el, 'button.act.stop'));
		expect(run.current()!.state).toBe('stopped');
		expect(w.sent('term_close').length).toBe(1);
		expect(terminals().tabs().length).toBe(1);
		expect(all(el, 'button.act').map((b) => b.getAttribute('aria-label'))).toEqual(['Run']);
	});

	test('Restart starts it again in place of the old tab', async () => {
		const el = await control();
		const { terminals } = await import('../../services/terminal.store');
		await click(find(el, 'button.act'));
		await click(find(el, 'button.act[title="Restart"]'));
		expect(w.sent('target_run').length).toBe(2);
		expect(terminals().tabs().length).toBe(1);
		expect(run.here().filter((r) => r.state === 'running').length).toBe(1);
	});

	test('the play button on a row selects that target and runs it', async () => {
		const el = await control();
		await click(find(item(el, 'test'), '.go'));
		expect(words(find(el, 'button.name')!)).toBe('test');
		expect(w.sent('target_run')[0].args.target).toBe('node::test');
	});

	test('a target that is gone from the project is said, and nothing runs', async () => {
		const el = await control();
		w.on('target_run', () => {
			throw { kind: 'error', message: 'That run target is no longer in this checkout' };
		});
		await click(find(el, 'button.act'));
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'That run target is no longer in this checkout' });
		expect(all(el, 'button.act').map((b) => b.getAttribute('aria-label'))).toEqual(['Run']);
	});
});

describe('a long list', () => {
	test('has a filter box, and folds every group but the selected target\'s', async () => {
		const el = await many();
		expect(find(el, '.filter ml-input')).not.toBeNull();
		expect(groups(el)).toEqual(['web 4', 'api 4', 'ui 4']);
		expect(items(el)).toEqual(['dev npm run dev', 'build npm run build', 'lint npm run lint', 'test npm run test']);
	});

	test('a group opens and folds on its heading', async () => {
		const el = await many();
		await click(all(el, '.group')[1]);
		expect(items(el).length).toBe(8);
		await click(all(el, '.group')[0]);
		expect(items(el).map((i) => i.split(' ')[0])).toEqual(['dev', 'build', 'migrate', 'seed']);
	});

	test('the filter takes every word, from the project, the name or the command, and unfolds what matches', async () => {
		const el = await many();
		await type(el, 'UI docs');
		expect(groups(el)).toEqual(['ui']);
		expect(items(el)).toEqual(['docs npm run docs --workspace ui']);
		await type(el, 'workspace seed');
		expect(items(el)).toEqual(['seed npm run seed --workspace api']);
	});

	test('nothing matching says so', async () => {
		const el = await many();
		await type(el, 'zzz');
		expect(words(find(el, '.none')!)).toBe('No targets match.');
		expect(items(el)).toEqual([]);
	});

	test('Enter in the filter takes the first target left, without running it', async () => {
		const el = await many();
		await type(el, 'migrate');
		find(el, '.filter ml-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
		await settle();
		expect(words(find(el, 'button.name')!)).toBe('api · migrate');
		expect(w.sent('target_run')).toEqual([]);
		expect(find<HTMLInputElement>(find(el, '.filter ml-input')!, 'input')!.value).toBe('');
	});

	test('a folded group says when something in it is running', async () => {
		const el = await many();
		await click(all(el, '.group')[1]);
		await click(find(item(el, 'migrate'), '.go'));
		// The run selects its target, so its group stays open by itself: fold it by hand.
		await click(all(el, '.group')[1]);
		expect(groups(el)[1]).toBe('api running 4');
	});

	test('opening the list clears the filter', async () => {
		const el = await many();
		await type(el, 'seed');
		await openList(el);
		expect(find<HTMLInputElement>(find(el, '.filter ml-input')!, 'input')!.value).toBe('');
		expect(groups(el)).toEqual(['web 4', 'api 4', 'ui 4']);
	});

	test('eight targets are still a short list', async () => {
		w.on('targets_list', () => MANY.slice(0, 8));
		const el = await control();
		expect(find(el, '.filter')).toBeNull();
		expect(items(el).length).toBe(8);
	});

	test('nine targets in one group get the filter but nothing to fold', async () => {
		w.on('targets_list', () => Array.from({ length: 9 }, (_, i) => target('package.json', `script-${i}`, `npm run script-${i}`)));
		const el = await control();
		expect(find(el, '.filter')).not.toBeNull();
		expect(groups(el)).toEqual(['package.json']);
		expect(items(el).length).toBe(9);
	});
});
