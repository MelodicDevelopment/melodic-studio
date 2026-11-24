import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type World } from '../test/world';
import type { BackendService, RunTarget } from './backend.service';
import type { RepoStore } from './repo.store';
import type { Run, RunStore } from './run.store';
import type { TerminalStore } from './terminal.store';

// xterm.js needs a real page to measure in. A stand-in that keeps what was written to it and lets a test
// type into it, so the pool is tested and the terminal emulator is not.
const xterm = vi.hoisted(() => {
	interface Key {
		type: string;
		key: string;
		shiftKey?: boolean;
		ctrlKey?: boolean;
		altKey?: boolean;
		metaKey?: boolean;
		preventDefault(): void;
	}
	class FakeTerminal {
		cols = 80;
		rows = 24;
		options: Record<string, unknown>;
		/** What was written to the screen, in order. */
		written: (string | Uint8Array)[] = [];
		host: HTMLElement | null = null;
		focused = false;
		disposed = false;
		selected = '';
		/** The handler the pool gave for keys: false means xterm leaves the key alone. */
		keys: (e: Key) => boolean = () => true;
		private _data: ((data: string) => void)[] = [];
		private _resize: ((size: { cols: number; rows: number }) => void)[] = [];
		constructor(options: Record<string, unknown> = {}) {
			this.options = { ...options };
			terms.push(this);
		}
		loadAddon(): void {}
		onData(fn: (data: string) => void): void {
			this._data.push(fn);
		}
		onResize(fn: (size: { cols: number; rows: number }) => void): void {
			this._resize.push(fn);
		}
		attachCustomKeyEventHandler(fn: (e: Key) => boolean): void {
			this.keys = fn;
		}
		open(host: HTMLElement): void {
			this.host = host;
		}
		write(data: string | Uint8Array): void {
			this.written.push(data);
		}
		/** As xterm does for a key or a paste: it goes to the program. */
		input(data: string): void {
			this._data.forEach((fn) => fn(data));
		}
		paste(data: string): void {
			this.input(data);
		}
		resize(cols: number, rows: number): void {
			this.cols = cols;
			this.rows = rows;
			this._resize.forEach((fn) => fn({ cols, rows }));
		}
		focus(): void {
			this.focused = true;
		}
		blur(): void {
			this.focused = false;
		}
		dispose(): void {
			this.disposed = true;
		}
		getSelection(): string {
			return this.selected;
		}
		hasSelection(): boolean {
			return !!this.selected;
		}
		clearSelection(): void {
			this.selected = '';
		}
		/** The screen's text so far. */
		text(): string {
			const decoder = new TextDecoder();
			return this.written.map((d) => (typeof d === 'string' ? d : decoder.decode(d, { stream: true }))).join('');
		}
	}
	const terms: FakeTerminal[] = [];
	return { terms, FakeTerminal };
});

vi.mock('../shared/xterm', () => ({
	loadXterm: async () => ({ Terminal: xterm.FakeTerminal, FitAddon: class { fit(): void {} }, WebLinksAddon: class {} }),
	adoptXtermStyles: () => undefined,
	xtermTheme: () => ({ background: document.documentElement.getAttribute('data-theme') === 'dark' ? '#000000' : '#ffffff' }),
}));


let w: World;
let repos: RepoStore;
let terms: TerminalStore;
let run: RunStore;
let backend: BackendService;

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';
const SELECTED_KEY = 'studio.run.selected';

function target(id: string, name: string, over: Partial<RunTarget> = {}): RunTarget {
	return { id, name, group: 'package.json', cwd: '', argv: ['npm', 'run', name], kind: 'run', runtime: 'node', source: 'package.json', ...over };
}

const BUILD = target('node::build', 'build');
const DEV = target('node::dev', 'dev');
const TEST = target('node::test', 'test', { argv: ['npm', 'test'], kind: 'test' });
const API = target('dotnet:src/Shop.Api:https', 'https', { group: 'Shop.Api · launch profiles', cwd: 'src/Shop.Api', argv: ['dotnet', 'run', '--launch-profile', 'https'], runtime: 'dotnet', source: 'launchSettings.json' });

/** A Node exception as it is printed, crashing at `file`; the block is still open (nothing follows it yet). */
function crash(file = `${HARMONY}/src/main.ts:12:47`, message = "Cannot read properties of null (reading 'title')"): string {
	return `TypeError: ${message}\r\n    at HTMLDocument.<anonymous> (${file})\r\n    at Queue.next (${HARMONY}/src/player/queue.ts:15:10)\r\n`;
}

/** Base64 of the bytes, as the native side sends terminal output. */
function b64(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function print(key: string, text: string): void {
	w.emit('term-data', { key, data: b64(text) });
}

/** Lets promises, frames and timers up to `ms` from now run. */
async function tick(ms = 20): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

/** A promise a test settles by hand, for an answer that is to arrive late. */
function later<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * The app started over, with `storage` as the last session left it. The checkout has `targets`, and
 * what is started gets the keys r1, r2, ... and the command line the project files give it.
 */
async function start(storage: Record<string, string> = {}, targets: RunTarget[] = [BUILD, DEV, TEST]): Promise<void> {
	xterm.terms.length = 0;
	w = await world();
	for (const [key, value] of Object.entries(storage)) {
		localStorage.setItem(key, value);
	}
	let n = 0;
	w.on('targets_list', () => targets);
	w.on('target_run', (args) => ({ key: `r${++n}`, port: null, command: `native: ${String(args.target)}` }));
	w.on('term_write', () => undefined);
	w.on('term_resize', () => undefined);
	w.on('term_close', () => undefined);
	backend = w.get((await import('./backend.service')).BackendService);
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	terms = w.get((await import('./terminal.store')).TerminalStore);
	run = w.get((await import('./run.store')).RunStore);
}

/** Put a worktree of the open repository on screen; answers its path. */
async function worktree(branch = 'agent/shuffle'): Promise<string> {
	const path = await backend.addWorktree(HARMONY, branch, null);
	await backend.selectWorktree(HARMONY, path);
	await repos.switchContext();
	return path;
}

async function mainCheckout(): Promise<void> {
	await backend.selectWorktree(HARMONY, null);
	await repos.switchContext();
}

/** Start a target (the selected one when left out) and wait for its tab. */
async function go(t?: RunTarget): Promise<Run | null> {
	const starting = t ? run.start(t) : run.start();
	await tick();
	return starting;
}

beforeEach(async () => {
	vi.useFakeTimers();
	await start();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('looking for targets', () => {
	test('nothing is known until the checkout has been looked at', () => {
		expect(run.targets()).toBeNull();
		expect(run.selected()).toBeNull();
		expect(run.loading()).toBe(false);
		expect(w.sent('targets_list')).toEqual([]);
	});

	test('a look asks for the open repository\'s targets', async () => {
		const looking = run.load();
		expect(run.loading()).toBe(true);
		await looking;
		expect(w.sent('targets_list').map((c) => c.args)).toEqual([{ id: HARMONY }]);
		expect(run.targets()).toEqual([BUILD, DEV, TEST]);
		expect(run.loading()).toBe(false);
	});

	test('a checkout with nothing to run has an empty list, not an unknown one', async () => {
		w.on('targets_list', () => []);
		await run.load();
		expect(run.targets()).toEqual([]);
	});

	test('no answer at all counts as nothing to run', async () => {
		w.on('targets_list', () => undefined);
		await run.load();
		expect(run.targets()).toEqual([]);
	});

	test('a look that fails shows no targets and says nothing', async () => {
		w.on('targets_list', () => { throw appError('error', 'cannot read package.json'); });
		await run.load();
		expect(run.targets()).toEqual([]);
		expect(run.loading()).toBe(false);
		expect(w.toasts).toEqual([]);
	});

	test('the same checkout on the same branch is not looked at twice', async () => {
		await run.load();
		await run.load();
		expect(w.sent('targets_list').length).toBe(1);
	});

	test('asked to, it looks again', async () => {
		await run.load();
		w.on('targets_list', () => [DEV]);
		await run.load(true);
		expect(w.sent('targets_list').length).toBe(2);
		expect(run.targets()).toEqual([DEV]);
	});

	test('a change of branch looks again, and the old list stays on screen meanwhile', async () => {
		await run.load();
		const status = repos.status()!;
		w.on('repo_status', () => ({ ...status, branch: 'feature/other' }));
		await repos.refresh();
		const answer = later<RunTarget[]>();
		w.on('targets_list', () => answer.promise);
		const looking = run.load();
		await tick();
		expect(w.sent('targets_list').length).toBe(2);
		expect(run.targets()).toEqual([BUILD, DEV, TEST]);
		answer.resolve([DEV, API]);
		await looking;
		expect(run.targets()).toEqual([DEV, API]);
	});

	test('a checkout never looked at has no list until the look is done', async () => {
		await run.load();
		await worktree();
		const answer = later<RunTarget[]>();
		w.on('targets_list', () => answer.promise);
		const looking = run.load();
		await tick();
		expect(run.targets()).toBeNull();
		answer.resolve([API]);
		await looking;
		expect(run.targets()).toEqual([API]);
	});

	test('going back to a checkout shows what was found there before, at once', async () => {
		await run.load();
		await worktree();
		w.on('targets_list', () => [API]);
		await run.load();
		await mainCheckout();
		const answer = later<RunTarget[]>();
		w.on('targets_list', () => answer.promise);
		const looking = run.load();
		await tick();
		// Not blank while the look is under way: the list seen here last time.
		expect(run.targets()).toEqual([BUILD, DEV, TEST]);
		answer.resolve([DEV]);
		await looking;
		expect(run.targets()).toEqual([DEV]);
	});

	test('another repository is a checkout of its own', async () => {
		await run.load();
		await repos.selectRepo(CADENCE);
		const answer = later<RunTarget[]>();
		w.on('targets_list', () => answer.promise);
		const looking = run.load();
		await tick();
		expect(w.sent('targets_list').at(-1)!.args).toEqual({ id: CADENCE });
		expect(run.targets()).toBeNull();
		answer.resolve([]);
		await looking;
		expect(run.targets()).toEqual([]);
		await repos.selectRepo(HARMONY);
		w.on('targets_list', () => later<RunTarget[]>().promise);
		void run.load();
		await tick();
		expect(run.targets()).toEqual([BUILD, DEV, TEST]);
	});

	test('an answer for the checkout that was left does not replace the list of the one on screen', async () => {
		const slow = later<RunTarget[]>();
		w.on('targets_list', () => slow.promise);
		const first = run.load();
		await tick();
		await repos.selectRepo(CADENCE);
		w.on('targets_list', () => [API]);
		await run.load();
		expect(run.targets()).toEqual([API]);
		slow.resolve([BUILD, DEV, TEST]);
		await first;
		expect(run.targets()).toEqual([API]);
	});

	test('with no repository open there is nothing to look at', async () => {
		await run.load();
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0' }));
		await repos.switchContext();
		await run.load();
		expect(run.targets()).toBeNull();
		expect(w.sent('targets_list').length).toBe(1);
	});
});

describe('the selected target', () => {
	test('until one is picked it is the likeliest way to start the app, not the first script', async () => {
		await run.load();
		expect(run.selected()).toEqual(DEV);
	});

	test('the usual names go in order of likelihood', async () => {
		await start({}, [target('node::serve', 'serve'), target('node::start', 'start'), BUILD]);
		await run.load();
		expect(run.selected()?.name).toBe('start');
	});

	test('a test target with a usual name is not taken for the app', async () => {
		await start({}, [target('x::dev', 'dev', { kind: 'test' }), BUILD]);
		await run.load();
		expect(run.selected()).toEqual(BUILD);
	});

	test('with no usual name it is the first thing that runs, and tests only when there is nothing else', async () => {
		await start({}, [TEST, BUILD, target('node::lint', 'lint')]);
		await run.load();
		expect(run.selected()).toEqual(BUILD);
		await start({}, [TEST]);
		await run.load();
		expect(run.selected()).toEqual(TEST);
		await start({}, []);
		await run.load();
		expect(run.selected()).toBeNull();
	});

	test('picking one is remembered for the repository', async () => {
		await run.load();
		run.select(TEST);
		expect(run.selected()).toEqual(TEST);
		expect(JSON.parse(localStorage.getItem(SELECTED_KEY)!)).toEqual({ [HARMONY]: TEST.id });
	});

	test('each repository has its own', async () => {
		await run.load();
		run.select(BUILD);
		await repos.selectRepo(CADENCE);
		await run.load();
		expect(run.selected()).toEqual(DEV);
		run.select(TEST);
		expect(JSON.parse(localStorage.getItem(SELECTED_KEY)!)).toEqual({ [HARMONY]: BUILD.id, [CADENCE]: TEST.id });
		await repos.selectRepo(HARMONY);
		await run.load();
		expect(run.selected()).toEqual(BUILD);
	});

	test('the pick comes back after a restart', async () => {
		await start({ [SELECTED_KEY]: JSON.stringify({ [HARMONY]: TEST.id }) });
		await run.load();
		expect(run.selected()).toEqual(TEST);
	});

	test('a remembered target that is no longer in the checkout gives way to the likeliest one', async () => {
		await start({ [SELECTED_KEY]: JSON.stringify({ [HARMONY]: 'node::gone' }) });
		await run.load();
		expect(run.selected()).toEqual(DEV);
	});

	test('damaged saved picks are ignored and picking still works', async () => {
		for (const broken of ['{not json', '[1,2]', 'null', '"dev"']) {
			await start({ [SELECTED_KEY]: broken });
			await run.load();
			expect(run.selected()).toEqual(DEV);
			run.select(BUILD);
			expect(run.selected()).toEqual(BUILD);
			expect(JSON.parse(localStorage.getItem(SELECTED_KEY)!)).toEqual({ [HARMONY]: BUILD.id });
		}
	});
});

describe('starting a run', () => {
	beforeEach(() => run.load());

	test('the target is named to the native side by its id: no command line comes from the window', async () => {
		await go();
		expect(w.sent('target_run').map((c) => c.args)).toEqual([{ id: HARMONY, target: DEV.id, cols: 80, rows: 24 }]);
	});

	test('a run is a tab of the terminal panel, named after its target', async () => {
		const r = await go(API);
		expect(terms.tabs()).toMatchObject([{ id: r!.id, kind: 'run', title: 'Shop.Api · https', repoId: HARMONY, cwd: HARMONY, ended: false }]);
		expect(terms.active()).toBe(r!.id);
		expect(terms.open()).toBe(true);
	});

	test('it knows its target, checkout and the command line the native side read', async () => {
		const r = await go();
		expect(r).toMatchObject({ repoId: HARMONY, checkout: HARMONY, target: DEV, command: `native: ${DEV.id}`, port: null, state: 'running', exitCode: null, errors: [] });
		expect(terms.tabs()[0].command).toBe(`native: ${DEV.id}`);
		expect(run.run(r!.id)).toEqual(r);
		expect(run.here()).toEqual([r]);
		expect(run.current()).toEqual(r);
	});

	test('a worktree\'s copy runs there, on the port it was given', async () => {
		const tree = await worktree();
		await run.load();
		w.on('target_run', () => ({ key: 'r1', port: 5174, command: 'npm run dev' }));
		const r = await go();
		expect(r).toMatchObject({ checkout: tree, port: 5174 });
		expect(terms.tabs()[0].cwd).toBe(tree);
	});

	test('with nothing to run nothing is started', async () => {
		await start({}, []);
		await run.load();
		expect(await go()).toBeNull();
		expect(w.sent('target_run')).toEqual([]);
		expect(terms.all()).toEqual([]);
	});

	test('a start that fails is said and leaves no run and no tab', async () => {
		w.on('target_run', () => { throw appError('error', 'That run target is no longer in this checkout'); });
		expect(await go()).toBeNull();
		expect(run.runs()).toEqual([]);
		expect(terms.all()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'That run target is no longer in this checkout' });
	});

	test('the current run is the selected target\'s, and other runs here are listed newest first', async () => {
		const dev = await go();
		await tick(1000);
		const tests = await go(TEST);
		expect(run.here().map((r) => r.id)).toEqual([tests!.id, dev!.id]);
		expect(run.current()?.id).toBe(dev!.id);
		run.select(TEST);
		expect(run.current()?.id).toBe(tests!.id);
		run.select(BUILD);
		expect(run.current()).toBeNull();
	});

	test('starting a target that already runs here stops that copy and takes its tab\'s place', async () => {
		const first = await go();
		const again = run.restart();
		await tick();
		const second = await again;
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'r1' }]);
		expect(w.sent('target_run').length).toBe(2);
		expect(second!.id).not.toBe(first!.id);
		expect(run.runs()).toEqual([second]);
		expect(terms.tabs().map((t) => t.id)).toEqual([second!.id]);
		expect(run.current()).toMatchObject({ id: second!.id, state: 'running' });
	});

	// A bug until 2026-11-23 (src/services/run.store.ts): `start` looks for the copy "already running here" among the
	// runs it has registered, and a run is registered (line 326) only once its tab is made and the native side has
	// answered. A second start before that (a double click on Run, Restart pressed twice) finds no copy to stop.
	// What holds now: one copy of the target running here, as the method's own comment promises.
	// Before the fix: `target_run` is sent twice and two copies run side by side, each in a tab.
	test('pressing Run twice before the first has started leaves one copy of the target running', async () => {
		const both = [run.start(), run.start()];
		await tick();
		await Promise.all(both);
		expect(run.here().filter((r) => r.target.id === DEV.id && r.state === 'running').length).toBe(1);
		expect(terms.tabs().filter((t) => !t.ended).length).toBe(1);
	});

	test('a run in another checkout is not one of this checkout\'s', async () => {
		const main = await go();
		await worktree();
		await run.load();
		expect(run.here()).toEqual([]);
		expect(run.current()).toBeNull();
		// Started here it does not replace the main checkout's copy.
		await go();
		expect(w.sent('term_close')).toEqual([]);
		expect(run.runs().length).toBe(2);
		await mainCheckout();
		expect(run.here().map((r) => r.id)).toEqual([main!.id]);
	});

	test('a run whose tab was closed is no longer one of the runs here', async () => {
		const r = await go();
		terms.close(r!.id);
		expect(run.here()).toEqual([]);
		expect(run.current()).toBeNull();
		await go(TEST);
		expect(run.runs().map((x) => x.target.id)).toEqual([TEST.id]);
	});

	test('a run the store does not know has no record', () => {
		expect(run.run(null)).toBeNull();
		expect(run.run('nope')).toBeNull();
	});
});

describe('a run ending', () => {
	beforeEach(() => run.load());

	test('a program that ends by itself keeps its tab and its exit code', async () => {
		const r = await go(BUILD);
		w.emit('term-exit', { key: 'r1', code: 0 });
		expect(run.run(r!.id)).toMatchObject({ state: 'ended', exitCode: 0, errors: [] });
		expect(terms.tabs()).toMatchObject([{ id: r!.id, ended: true }]);
		expect(run.here().length).toBe(1);
	});

	test('stop ends the program, keeps the tab, and the code the kill left is not taken as its verdict', async () => {
		const r = await go();
		run.stop();
		expect(run.run(r!.id)!.state).toBe('stopped');
		await tick();
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'r1' }]);
		w.emit('term-exit', { key: 'r1', code: 130 });
		expect(run.run(r!.id)).toMatchObject({ state: 'stopped', exitCode: null, errors: [] });
		expect(terms.tabs()).toMatchObject([{ id: r!.id, ended: true }]);
	});

	test('stopping a run that is not running does nothing', async () => {
		const r = await go(BUILD);
		w.emit('term-exit', { key: 'r1', code: 0 });
		run.stop(run.run(r!.id));
		run.stop(null);
		await tick();
		expect(w.sent('term_close')).toEqual([]);
		expect(run.run(r!.id)!.state).toBe('ended');
	});

	test('stop with no run named stops the selected target\'s', async () => {
		await go(TEST);
		const dev = await go();
		run.stop();
		expect(run.runs().map((r) => r.state)).toEqual(['running', 'stopped']);
		expect(run.run(dev!.id)!.state).toBe('stopped');
	});

	test('a program that ended before its tab was known here is still recorded as ended', async () => {
		w.on('target_run', () => {
			print('r1', 'sh: vite: command not found\r\n');
			w.emit('term-exit', { key: 'r1', code: 127 });
			return { key: 'r1', port: null, command: 'npm run dev' };
		});
		const r = await go();
		expect(r).toMatchObject({ state: 'ended', exitCode: 127 });
		expect(r!.errors.map((e) => e.summary)).toEqual(['Exited with code 127']);
	});
});

describe('errors spotted in the output', () => {
	beforeEach(() => run.load());

	test('an exception is listed with where it crashed, as a path inside the repository', async () => {
		const r = await go();
		print('r1', `${crash()}[player] the page reloaded\r\n`);
		const errors = run.run(r!.id)!.errors;
		expect(errors).toMatchObject([{ kind: 'exception', type: 'TypeError', dismissed: false, site: { path: 'src/main.ts', line: 12, column: 47 } }]);
		expect(run.crashes()).toMatchObject([{ path: 'src/main.ts', line: 12, type: 'TypeError', summary: errors[0].summary }]);
	});

	test('colour codes around it do not hide it', async () => {
		const r = await go();
		print('r1', `\x1b[31m${crash().replace('\r\n', '\x1b[0m\r\n')}after\r\n`);
		expect(run.run(r!.id)!.errors.length).toBe(1);
	});

	test('output cut anywhere is read as one stream', async () => {
		const r = await go();
		const text = `${crash()}after\r\n`;
		for (let i = 0; i < text.length; i += 7) {
			print('r1', text.slice(i, i + 7));
		}
		expect(run.run(r!.id)!.errors).toMatchObject([{ type: 'TypeError', site: { path: 'src/main.ts', line: 12 } }]);
	});

	test('an error the output stops at is taken as complete once the output has been quiet for half a second', async () => {
		const r = await go();
		print('r1', crash());
		await tick(400);
		expect(run.run(r!.id)!.errors).toEqual([]);
		await tick(100);
		expect(run.run(r!.id)!.errors.length).toBe(1);
	});

	test('more output keeps the wait going', async () => {
		const r = await go();
		print('r1', crash());
		await tick(400);
		print('r1', `    at Player.play (${HARMONY}/src/player/player.ts:40:3)\r\n`);
		await tick(400);
		expect(run.run(r!.id)!.errors).toEqual([]);
		await tick(100);
		expect(run.run(r!.id)!.errors.length).toBe(1);
		expect(run.run(r!.id)!.errors[0].frames.length).toBe(3);
	});

	test('output that arrived before the tab was known here is read too', async () => {
		w.on('target_run', () => {
			print('r1', `${crash()}after\r\n`);
			return { key: 'r1', port: null, command: 'npm run dev' };
		});
		const r = await go();
		expect(r!.errors).toMatchObject([{ type: 'TypeError', site: { path: 'src/main.ts' } }]);
	});

	test('an error-level log line with no stack is not an error', async () => {
		const r = await go();
		print('r1', 'error: upstream timed out, retrying\r\n[ERROR] cache miss\r\nready\r\n');
		await tick(600);
		expect(run.run(r!.id)!.errors).toEqual([]);
		expect(run.crashes()).toEqual([]);
	});

	test('a non-zero exit code that nothing else explains is an error of its own, with no place in the code', async () => {
		const r = await go(BUILD);
		print('r1', 'compiling\r\n');
		w.emit('term-exit', { key: 'r1', code: 3 });
		expect(run.run(r!.id)).toMatchObject({ state: 'ended', exitCode: 3 });
		expect(run.run(r!.id)!.errors).toMatchObject([{ kind: 'exit', summary: 'Exited with code 3', site: null }]);
		expect(run.crashes()).toEqual([]);
	});

	test('an exit code right after an exception is explained by it', async () => {
		const r = await go();
		print('r1', crash());
		w.emit('term-exit', { key: 'r1', code: 1 });
		expect(run.run(r!.id)!.errors.map((e) => e.kind)).toEqual(['exception']);
		expect(run.run(r!.id)!.exitCode).toBe(1);
	});

	test('an error open when the run is stopped is kept, and the kill\'s exit code adds none', async () => {
		const r = await go();
		print('r1', crash());
		run.stop();
		w.emit('term-exit', { key: 'r1', code: 130 });
		expect(run.run(r!.id)!.errors.map((e) => e.kind)).toEqual(['exception']);
		// Nothing more turns up when the quiet wait would have ended.
		await tick(600);
		expect(run.run(r!.id)!.errors.length).toBe(1);
	});

	test('a crash inside a dependency or outside the checkout has no place to mark', async () => {
		const r = await go();
		print('r1', `Error: boom\r\n    at run (${HARMONY}/node_modules/lib/index.js:3:1)\r\n    at main (/opt/elsewhere/tool.js:9:2)\r\nafter\r\n`);
		expect(run.run(r!.id)!.errors).toMatchObject([{ type: 'Error', site: null }]);
		expect(run.crashes()).toEqual([]);
	});

	test('the first frame inside the checkout is the place, passing over dependencies', async () => {
		const r = await go();
		print('r1', `Error: boom\r\n    at run (${HARMONY}/node_modules/lib/index.js:3:1)\r\n    at handler (${HARMONY}/src/api/orders.ts:88:5)\r\nafter\r\n`);
		expect(run.run(r!.id)!.errors[0].site).toEqual({ path: 'src/api/orders.ts', line: 88, column: 5 });
	});

	test('in a worktree the place is relative to the worktree', async () => {
		const tree = await worktree();
		await run.load();
		const r = await go();
		print('r1', `${crash(`${tree}/src/main.ts:12:47`)}after\r\n`);
		expect(run.run(r!.id)!.errors[0].site).toMatchObject({ path: 'src/main.ts', line: 12 });
		// The same file in the main checkout is not this checkout's.
		print('r1', `${crash(`${HARMONY}/src/other.ts:5:1`)}after\r\n`);
		expect(run.run(r!.id)!.errors[1].site).toBeNull();
	});

	test('a dismissed error stays in the run and loses its mark', async () => {
		const r = await go();
		print('r1', `${crash()}after\r\n`);
		const error = run.run(r!.id)!.errors[0];
		run.dismiss(r!.id, error.id);
		expect(run.run(r!.id)!.errors).toMatchObject([{ id: error.id, dismissed: true }]);
		expect(run.crashes()).toEqual([]);
	});

	test('a line of code that crashed twice has one mark, the latest', async () => {
		const r = await go();
		print('r1', `${crash(undefined, 'first')}after\r\n`);
		await tick(1000);
		print('r1', `${crash(`${HARMONY}/src/main.ts:30:1`, 'elsewhere')}after\r\n`);
		await tick(1000);
		print('r1', `${crash(undefined, 'second')}after\r\n`);
		expect(run.run(r!.id)!.errors.length).toBe(3);
		// Newest first.
		expect(run.crashes().map((m) => [m.line, m.summary])).toEqual([
			[12, expect.stringContaining('second')],
			[30, expect.stringContaining('elsewhere')],
		]);
	});

	test('marks are only those of the checkout on screen, and go with the run\'s tab', async () => {
		const r = await go();
		print('r1', `${crash()}after\r\n`);
		expect(run.crashes().length).toBe(1);
		await worktree();
		expect(run.crashes()).toEqual([]);
		await mainCheckout();
		expect(run.crashes().length).toBe(1);
		terms.close(r!.id);
		expect(run.crashes()).toEqual([]);
	});

	test('every error has an id of its own across runs', async () => {
		const a = await go();
		print('r1', `${crash()}after\r\n`);
		const b = await go(TEST);
		print('r2', `${crash()}after\r\n`);
		const ids = [...run.run(a!.id)!.errors, ...run.run(b!.id)!.errors].map((e) => e.id);
		expect(new Set(ids).size).toBe(2);
	});
});

describe('the target list', () => {
	let m: typeof import('./run.store');

	beforeEach(async () => {
		m = await import('./run.store');
	});

	test('the filter keeps targets that have every word, in the group, the name or the command', () => {
		const all = [BUILD, DEV, TEST, API];
		expect(m.filterTargets(all, 'shop')).toEqual([API]);
		expect(m.filterTargets(all, 'dev')).toEqual([DEV]);
		expect(m.filterTargets(all, 'launch-profile')).toEqual([API]);
		expect(m.filterTargets(all, 'npm run')).toEqual([BUILD, DEV]);
		expect(m.filterTargets(all, 'run npm')).toEqual([BUILD, DEV]);
		expect(m.filterTargets(all, 'npm shop')).toEqual([]);
	});

	test('the filter ignores case and extra spaces, and an empty one keeps everything', () => {
		const all = [BUILD, DEV, TEST, API];
		expect(m.filterTargets(all, '  SHOP.api   HTTPS ')).toEqual([API]);
		expect(m.filterTargets(all, '')).toEqual(all);
		expect(m.filterTargets(all, '   ')).toEqual(all);
	});

	test('targets are listed under their group headings in the order they were found', () => {
		const other = target('dotnet:src/Shop.Api:http', 'http', { group: API.group, source: API.source });
		expect(m.groupTargets([BUILD, API, DEV, other])).toEqual([
			{ group: 'package.json', targets: [BUILD, DEV] },
			{ group: API.group, targets: [API, other] },
		]);
		expect(m.groupTargets([])).toEqual([]);
	});

	test('a group says which files its targets were read from', () => {
		expect(m.foundIn([BUILD, DEV])).toBe('Found in package.json');
		expect(m.foundIn([BUILD, API])).toBe('Found in package.json, launchSettings.json');
		expect(m.foundIn([])).toBe('');
	});

	test('a target is named with its project, unless the group is only a file name', () => {
		expect(m.projectOf(API)).toBe('Shop.Api');
		expect(m.targetTitle(API)).toBe('Shop.Api · https');
		expect(m.targetTitle(DEV)).toBe('dev');
		expect(m.targetTitle(target('node:web:dev', 'dev', { group: 'web · package.json' }))).toBe('web · dev');
		expect(m.targetTitle(target('rust::shop', 'shop', { group: 'shop · Cargo.toml', source: 'Cargo.toml' }))).toBe('shop');
	});

	test('a frame\'s file becomes a repository-relative path, or nothing when it is outside the checkout', () => {
		expect(m.frameInCheckout(`${HARMONY}/src/main.ts`, HARMONY, '')).toBe('src/main.ts');
		expect(m.frameInCheckout('/usr/lib/node/internal.js', HARMONY, '')).toBeNull();
		expect(m.frameInCheckout(`${HARMONY}-other/src/main.ts`, HARMONY, '')).toBeNull();
		// A path relative to where the program ran, which is the target's folder.
		expect(m.frameInCheckout('src/main.ts', HARMONY, '')).toBe('src/main.ts');
		expect(m.frameInCheckout('./Controllers/Orders.cs', HARMONY, 'src/Shop.Api')).toBe('src/Shop.Api/Controllers/Orders.cs');
		expect(m.frameInCheckout('../outside.ts', HARMONY, 'src')).toBeNull();
		// Windows spells the same checkout loosely.
		expect(m.frameInCheckout('c:\\Users\\me\\shop\\src\\a.ts', 'C:\\Users\\me\\shop', '')).toBe('src/a.ts');
		expect(m.frameInCheckout('D:\\other\\a.ts', 'C:\\Users\\me\\shop', '')).toBeNull();
	});
});
