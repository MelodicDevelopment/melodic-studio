import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type World } from '../test/world';
import type { LanguageServersStore } from './language-servers.store';
import type { RepoStore } from './repo.store';
import type { LanguageServer } from './backend.service';

/**
 * The language servers' client, which the store only tells to try again: each `refresh` is noted with
 * the commands sent to the native side so far, so a test can say what came before it.
 */
const lsp = vi.hoisted(() => ({ refreshed: [] as string[][], sentSoFar: () => [] as string[], wait: null as Promise<void> | null }));

vi.mock('./lsp.service', () => ({
	LspService: class {
		async refresh(): Promise<void> {
			lsp.refreshed.push(lsp.sentSoFar());
			await lsp.wait;
		}
	},
}));

const HARMONY = '/Users/demo/Source/harmony';

function server(name: string, over: Partial<LanguageServer> = {}): LanguageServer {
	return { name, label: name, program: `${name}-language-server`, source: null, path: null, version: null, problem: null, managed: false, installable: true, prerequisite: 'npm', prerequisiteFound: true, hint: null, ...over };
}

const MISSING = server('typescript');
const INSTALLED = server('typescript', { source: 'managed', path: '/data/language-servers/node/bin/typescript-language-server', version: '5.1.3', managed: true });
const RUST = server('rust', { installable: false, hint: 'rustup component add rust-analyzer' });

let w: World;
let store: LanguageServersStore;
/** What is on this computer: `lsp_servers`' answer. */
let found: LanguageServer[];

/** An answer that waits until the test lets it go. */
function gate<T = void>(): { wait: Promise<T>; open: (value: T) => void } {
	let open!: (value: T) => void;
	const wait = new Promise<T>((resolve) => (open = resolve));
	return { wait, open };
}

/** The commands about language servers sent so far, in order. */
const commands = (): string[] => w.calls.filter((c) => c.cmd.startsWith('lsp_')).map((c) => c.cmd);

async function start(withRepository = true): Promise<void> {
	w = await world();
	found = [MISSING, RUST];
	lsp.refreshed = [];
	lsp.wait = null;
	lsp.sentSoFar = commands;
	w.on('lsp_servers', () => found);
	w.on('lsp_install', () => {
		found = [INSTALLED, RUST];
	});
	w.on('lsp_uninstall', () => {
		found = [MISSING, RUST];
	});
	// The stand-in above is a plain class, the same one in every test: this test's injector has to be told of it.
	const { Injectable } = await import('@melodicdev/core/injection');
	Injectable()((await import('./lsp.service')).LspService);
	if (withRepository) {
		const repos: RepoStore = w.get((await import('./repo.store')).RepoStore);
		await repos.init();
	}
	store = w.get((await import('./language-servers.store')).LanguageServersStore);
}

describe('looking for the servers', () => {
	beforeEach(() => start());

	test('nothing is known, or asked, until the list is looked up', async () => {
		expect(store.servers()).toBeNull();
		expect(w.sent('lsp_servers')).toEqual([]);
		await store.load();
		expect(store.servers()).toEqual([MISSING, RUST]);
	});

	test('they are looked for in the repository on screen', async () => {
		await store.load();
		expect(w.sent('lsp_servers').map((c) => c.args)).toEqual([{ id: HARMONY }]);
	});

	test('with no repository open, the app\'s own copies and PATH are still looked at', async () => {
		await start(false);
		await store.load();
		expect(w.sent('lsp_servers').map((c) => c.args)).toEqual([{ id: null }]);
		expect(store.servers()).toEqual([MISSING, RUST]);
	});

	test('every look reads again: a server installed from a terminal shows up', async () => {
		await store.load();
		found = [INSTALLED, RUST];
		await store.load();
		expect(store.servers()![0].version).toBe('5.1.3');
		expect(w.sent('lsp_servers').length).toBe(2);
	});

	test('a look that fails keeps the list as it was', async () => {
		await store.load();
		w.on('lsp_servers', () => {
			throw appError('error', 'npm did not answer');
		});
		await store.load();
		expect(store.servers()).toEqual([MISSING, RUST]);
		expect(w.toasts).toEqual([]);
	});

	test('a first look that fails shows an empty list rather than "looking" for ever', async () => {
		w.on('lsp_servers', () => {
			throw appError('error', 'npm did not answer');
		});
		await store.load();
		expect(store.servers()).toEqual([]);
	});

	test('a native side that answers nothing counts as no servers', async () => {
		w.on('lsp_servers', () => undefined);
		await store.load();
		expect(store.servers()).toEqual([]);
	});

	test('an older look that answers late does not replace a newer one', async () => {
		const older = gate<LanguageServer[]>();
		let asked = 0;
		w.on('lsp_servers', () => (asked++ === 0 ? older.wait : [INSTALLED, RUST]));
		const first = store.load();
		await store.load();
		older.open([MISSING, RUST]);
		await first;
		expect(store.servers()).toEqual([INSTALLED, RUST]);
	});

	test('an older look that fails late does not put the old list back', async () => {
		await store.load();
		let rejectOlder!: (reason: unknown) => void;
		const older = new Promise<LanguageServer[]>((_, reject) => (rejectOlder = reject));
		let asked = 0;
		w.on('lsp_servers', () => (asked++ === 0 ? older : [INSTALLED, RUST]));
		const first = store.load();
		await store.load();
		rejectOlder(appError('error', 'timed out'));
		await first;
		expect(store.servers()).toEqual([INSTALLED, RUST]);
	});
});

describe('installing', () => {
	beforeEach(async () => {
		await start();
		await store.load();
	});

	test('the server is named to the native side, and marked as being installed until that ends', async () => {
		const npm = gate();
		w.on('lsp_install', async () => {
			await npm.wait;
			found = [INSTALLED, RUST];
		});
		const installing = store.install('typescript');
		expect(store.busy()).toEqual({ typescript: 'install' });
		npm.open();
		await installing;
		expect(w.sent('lsp_install').map((c) => c.args)).toEqual([{ name: 'typescript' }]);
		expect(store.busy()).toEqual({});
		expect(store.errors()).toEqual({});
	});

	test('afterwards the list is read again, and then the open files are given the server that arrived', async () => {
		await store.install('typescript');
		expect(store.servers()).toEqual([INSTALLED, RUST]);
		expect(commands()).toEqual(['lsp_servers', 'lsp_install', 'lsp_servers']);
		expect(lsp.refreshed).toEqual([['lsp_servers', 'lsp_install', 'lsp_servers']]);
	});

	test('the install is over, as far as the row shows, before the open files have been gone through', async () => {
		const slow = gate();
		lsp.wait = slow.wait;
		const installing = store.install('typescript');
		await vi.waitFor(() => expect(lsp.refreshed.length).toBe(1));
		expect(store.busy()).toEqual({});
		expect(store.servers()).toEqual([INSTALLED, RUST]);
		slow.open();
		await installing;
	});

	test('a failure is kept with the server, in the installer\'s words, and the list is still read again', async () => {
		w.on('lsp_install', () => {
			throw appError('error', 'npm ERR! network request failed');
		});
		await store.install('typescript');
		expect(store.errors()).toEqual({ typescript: 'npm ERR! network request failed' });
		expect(store.busy()).toEqual({});
		expect(w.sent('lsp_servers').length).toBe(2);
		expect(lsp.refreshed.length).toBe(1);
		// Said in the server's row of Settings, not as a toast.
		expect(w.toasts).toEqual([]);
	});

	test('a failure that is not the native side\'s is still said', async () => {
		w.on('lsp_install', () => {
			throw new Error('the window lost its connection');
		});
		await store.install('typescript');
		expect(store.errors()).toEqual({ typescript: 'the window lost its connection' });
	});

	test('trying again takes the old failure away at once, and for good when it works', async () => {
		w.on('lsp_install', () => {
			throw appError('error', 'npm ERR! network request failed');
		});
		await store.install('typescript');
		const npm = gate();
		w.on('lsp_install', () => npm.wait);
		const again = store.install('typescript');
		expect(store.errors()).toEqual({});
		npm.open();
		await again;
		expect(store.errors()).toEqual({});
	});

	test('a second click while the server is being installed does nothing', async () => {
		const npm = gate();
		w.on('lsp_install', () => npm.wait);
		const first = store.install('typescript');
		await store.install('typescript');
		await store.remove('typescript');
		expect(store.busy()).toEqual({ typescript: 'install' });
		npm.open();
		await first;
		expect(w.sent('lsp_install').length).toBe(1);
		expect(w.sent('lsp_uninstall')).toEqual([]);
		expect(lsp.refreshed.length).toBe(1);
	});

	test('two servers can be installed at once, and one\'s failure is not the other\'s', async () => {
		const typescript = gate();
		const php = gate();
		w.on('lsp_install', async (args) => {
			if (args.name === 'typescript') {
				await typescript.wait;
				return;
			}
			await php.wait;
			throw appError('error', 'npm ERR! intelephense');
		});
		const one = store.install('typescript');
		const two = store.install('php');
		expect(store.busy()).toEqual({ typescript: 'install', php: 'install' });
		php.open();
		await two;
		expect(store.busy()).toEqual({ typescript: 'install' });
		expect(store.errors()).toEqual({ php: 'npm ERR! intelephense' });
		typescript.open();
		await one;
		expect(store.busy()).toEqual({});
		expect(store.errors()).toEqual({ php: 'npm ERR! intelephense' });
	});
});

describe('removing', () => {
	beforeEach(async () => {
		await start();
		found = [INSTALLED, RUST];
		await store.load();
	});

	test('the app\'s copy is removed, the list read again and the open files let go of the server', async () => {
		const removing = store.remove('typescript');
		expect(store.busy()).toEqual({ typescript: 'remove' });
		await removing;
		expect(w.sent('lsp_uninstall').map((c) => c.args)).toEqual([{ name: 'typescript' }]);
		expect(w.sent('lsp_install')).toEqual([]);
		expect(store.busy()).toEqual({});
		expect(store.servers()).toEqual([MISSING, RUST]);
		expect(lsp.refreshed).toEqual([['lsp_servers', 'lsp_uninstall', 'lsp_servers']]);
	});

	test('a removal that fails is kept with the server', async () => {
		w.on('lsp_uninstall', () => {
			throw appError('error', 'The server is still running');
		});
		await store.remove('typescript');
		expect(store.errors()).toEqual({ typescript: 'The server is still running' });
		expect(store.servers()).toEqual([INSTALLED, RUST]);
		expect(store.busy()).toEqual({});
	});
});

describe('"Restart"', () => {
	test('has the open files try their servers again, then reads the list again', async () => {
		await start();
		await store.load();
		found = [server('typescript', { source: 'path', path: '/usr/local/bin/typescript-language-server', problem: 'exited with code 1' }), RUST];
		await store.restart();
		expect(lsp.refreshed).toEqual([['lsp_servers']]);
		expect(w.sent('lsp_servers').length).toBe(2);
		expect(store.servers()![0].problem).toBe('exited with code 1');
		expect(w.sent('lsp_install')).toEqual([]);
		expect(w.sent('lsp_uninstall')).toEqual([]);
	});
});
