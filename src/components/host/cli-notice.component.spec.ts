import { afterEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { HostWorkStore } from '../../services/host-work.store';
import type { HostCli } from '../../services/backend.service';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let work: HostWorkStore;
const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');

const SIGNED_IN = { provider: 'github', name: 'GitHub', cli: 'gh', installed: true, signedIn: true, account: 'rick', hint: null } as unknown as HostCli;
const SIGNED_OUT = { ...SIGNED_IN, signedIn: false, account: null } as HostCli;
const MISSING = { ...SIGNED_OUT, installed: false } as HostCli;

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

/** The `ml-button` that reads `label`. */
function button(root: Element, label: string): HTMLElement {
	const found = all(root, 'ml-button').find((b) => words(b) === label);
	if (!found) {
		throw new Error(`no button "${label}" among: ${all(root, 'ml-button').map((b) => words(b)).join(' | ')}`);
	}
	return found;
}

async function press(root: Element, label: string): Promise<void> {
	await click(find(button(root, label), 'button'));
}

/** The app on this platform (`navigator.platform` is what `isMac()` and `isWindows()` read), with GitHub's tool as given. */
async function start(tool: HostCli, on = 'MacIntel'): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	popovers();
	// The demo host answers after a real pause; the tools are answered here.
	w.on('host_clis', () => [tool]);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	work = w.get((await import('../../services/host-work.store')).HostWorkStore);
	await repos.init();
}

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

async function notice(props: Record<string, unknown> = {}): Promise<HTMLElement> {
	const el = await mount('ms-cli-notice', { provider: 'github', what: 'pull requests', ...props });
	await settle();
	return el;
}

function commands(el: Element): string[] {
	return all(el, '.cmd code').map((c) => c.textContent ?? '');
}

describe('when the tool can be used', () => {
	test('there is no notice', async () => {
		await start(SIGNED_IN);
		const el = await notice();
		expect(w.sent('host_clis').length).toBe(1);
		expect(find(el, '.notice')).toBeNull();
		expect(words(el)).toBe('');
	});

	test('a host with no tool of ours has no notice either', async () => {
		await start(MISSING);
		const el = await notice({ provider: 'bitbucket' });
		expect(find(el, '.notice')).toBeNull();
	});
});

describe('when the tool is not installed', () => {
	test('says what installing it would show here, what it unlocks and how to get it', async () => {
		await start(MISSING);
		const el = await notice();
		expect(words(find(el, '.notice b')!)).toBe('Install the GitHub CLI to see pull requests here');
		expect(words(find(el, '.notice p')!)).toBe('Issues, pull requests (browse, review, merge, check out), Actions runs and new repositories on GitHub.');
		expect(commands(el)).toEqual(['brew install gh']);
		expect(all(el, 'ml-button').map((b) => words(b))).toEqual(['Install page', 'Check again', 'Not now']);
	});

	test('says that nothing is installed for you and no token is kept', async () => {
		await start(MISSING);
		const el = await notice();
		expect(words(find(el, 'p.dim')!)).toBe('Nothing is installed for you, and Melodic Studio keeps no tokens: the tool holds its own sign-in.');
	});

	test('"Install page" opens the vendor\'s page; nothing else is run', async () => {
		await start(MISSING);
		w.on('plugin:opener|open_url', () => undefined);
		const el = await notice();
		const before = w.calls.length;
		await press(el, 'Install page');
		expect(w.calls.slice(before).map((c) => [c.cmd, c.args.url])).toEqual([['plugin:opener|open_url', 'https://cli.github.com']]);
	});

	test('on Windows the line is winget\'s; on Linux there is only the page', async () => {
		await start(MISSING, 'Win32');
		expect(commands(await notice())).toEqual(['winget install --id GitHub.cli']);
		await start(MISSING, 'Linux x86_64');
		const linux = await notice();
		expect(commands(linux)).toEqual([]);
		expect(button(linux, 'Install page')).toBeDefined();
	});

	test('the Azure CLI also needs its extension', async () => {
		await start({ ...MISSING, provider: 'azure', name: 'Azure DevOps', cli: 'az' } as HostCli);
		const el = await notice({ provider: 'azure', what: 'work items' });
		expect(words(find(el, '.notice b')!)).toBe('Install the Azure CLI with the azure-devops extension to see work items here');
		expect(commands(el)).toEqual(['brew install azure-cli', 'az extension add --name azure-devops']);
	});

	test('the copy button copies the command', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await start(MISSING);
		const el = await notice();
		await click(find(el, '.cmd button'));
		expect(writeText).toHaveBeenCalledWith('brew install gh');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Copied' });
	});
});

describe('when the tool is signed out', () => {
	test('says so, with the command that signs in', async () => {
		await start(SIGNED_OUT);
		const el = await notice();
		expect(words(find(el, '.notice b')!)).toBe('Sign in to gh to see pull requests here');
		expect(commands(el)).toEqual(['gh auth login']);
		expect(all(el, 'ml-button').map((b) => words(b))).toEqual(['Type it in the terminal', 'Check again', 'Not now']);
	});

	test('"Type it in the terminal" puts the command on a terminal\'s line for the user to run', async () => {
		await start(SIGNED_OUT);
		const { TerminalStore } = await import('../../services/terminal.store');
		const add = vi.spyOn(w.get(TerminalStore), 'add').mockResolvedValue();
		const el = await notice();
		await press(el, 'Type it in the terminal');
		expect(add).toHaveBeenCalledWith(null, 'gh auth login');
	});
});

describe('checking again', () => {
	test('"Check again" asks the tools again, and the notice goes once the tool is ready', async () => {
		await start(SIGNED_OUT);
		const el = await notice();
		w.on('host_clis', () => [SIGNED_IN]);
		await press(el, 'Check again');
		expect(w.sent('host_clis').length).toBe(2);
		expect(find(el, '.notice')).toBeNull();
	});

	test('coming back to the window looks again, since that is where the tool was installed', async () => {
		await start(SIGNED_OUT);
		const el = await notice();
		w.on('host_clis', () => [SIGNED_IN]);
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(w.sent('host_clis').length).toBe(2);
		expect(find(el, '.notice')).toBeNull();
	});

	test('with the tool ready, coming back asks nothing', async () => {
		await start(SIGNED_IN);
		await notice();
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(w.sent('host_clis').length).toBe(1);
	});
});

describe('"Not now"', () => {
	test('puts the notice away for that tool, and it stays away', async () => {
		await start(MISSING);
		const el = await notice();
		await press(el, 'Not now');
		expect(find(el, '.notice')).toBeNull();
		expect(JSON.parse(localStorage.getItem('studio.notices.dismissed')!)).toEqual(['gh']);
		const again = await notice({ what: 'issues' });
		expect(find(again, '.notice')).toBeNull();
	});

	test('inside the feature\'s own dialog the notice always shows, and cannot be put away', async () => {
		await start(MISSING);
		work.dismiss('gh');
		const el = await notice({ always: true });
		expect(find(el, '.notice')).not.toBeNull();
		expect(all(el, 'ml-button').map((b) => words(b))).toEqual(['Install page', 'Check again']);
	});
});
