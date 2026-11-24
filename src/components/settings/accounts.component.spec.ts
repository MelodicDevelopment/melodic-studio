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

/** The four tools in the states a person meets: signed in, signed out, missing. */
const TOOLS = [
	{ provider: 'github', name: 'GitHub', cli: 'gh', installed: true, signedIn: true, account: 'rick', hint: null },
	{ provider: 'azure', name: 'Azure DevOps', cli: 'az', installed: true, signedIn: false, account: null, hint: 'Run `az login`.' },
	{ provider: 'gitlab', name: 'GitLab', cli: 'glab', installed: false, signedIn: false, account: null, hint: null },
	{ provider: 'jira', name: 'Jira', cli: 'acli', installed: true, signedIn: true, account: null, hint: null },
] as unknown as HostCli[];

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

/** The app on this platform (`navigator.platform` is what `isMac()` and `isWindows()` read), the section on screen. */
async function start(on = 'MacIntel', tools: HostCli[] = TOOLS, active = true): Promise<HTMLElement> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	popovers();
	// The demo host answers after a real pause; the tools are answered here.
	w.on('host_clis', () => tools);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	work = w.get((await import('../../services/host-work.store')).HostWorkStore);
	await repos.init();
	return mount('ms-accounts', active ? { active: true } : {});
}

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

function tool(el: Element, name: string): HTMLElement {
	return all(el, '.tool').find((t) => find(t, '.head b')!.textContent === name)!;
}

function commands(el: Element, name: string): string[] {
	return all(tool(el, name), '.cmd code').map((c) => c.textContent ?? '');
}

function button(root: Element, label: string): HTMLElement {
	return find(all(root, 'ml-button').find((b) => words(b) === label)!, 'button')!;
}

describe('the tools', () => {
	test('are not asked about until the tab is on screen', async () => {
		const el = await start('MacIntel', TOOLS, false);
		expect(w.sent('host_clis')).toEqual([]);
		expect(find(el, 'ml-spinner')).not.toBeNull();
		(el as HTMLElement & { active: boolean }).active = true;
		await settle();
		expect(w.sent('host_clis').length).toBe(1);
		expect(all(el, '.tool').length).toBe(4);
	});

	test('says that the app keeps no passwords or tokens', async () => {
		const el = await start();
		expect(words(find(el, 'p.dim')!)).toBe('Melodic Studio talks to GitHub, Azure DevOps, GitLab and Jira only through their own command-line tools, signed in by you. It stores no passwords or tokens.');
		expect(all(el, 'input[type=password]')).toEqual([]);
	});

	test('a tool that is signed in says who as, and needs nothing', async () => {
		const el = await start();
		expect(words(find(tool(el, 'GitHub'), '.head')!)).toBe('GitHub gh Signed in as rick');
		expect(words(find(tool(el, 'Jira'), '.head')!)).toBe('Jira acli Signed in');
		expect(commands(el, 'GitHub')).toEqual([]);
		expect(all(tool(el, 'GitHub'), 'ml-button')).toEqual([]);
	});

	test('a tool that is installed but signed out says what it unlocks and the command that signs in', async () => {
		const el = await start();
		const azure = tool(el, 'Azure DevOps');
		expect(words(find(azure, '.head')!)).toBe('Azure DevOps az Installed, not signed in');
		expect(words(find(azure, 'small')!)).toBe('Work items, pull requests (browse, vote, complete), pipeline runs and new repositories on Azure DevOps.');
		expect(commands(el, 'Azure DevOps')).toEqual(['az login']);
	});

	test('"Type it in the terminal" closes Settings and puts the command on a terminal\'s line, not run', async () => {
		const el = await start();
		const { TerminalStore } = await import('../../services/terminal.store');
		const add = vi.spyOn(w.get(TerminalStore), 'add').mockResolvedValue();
		const close = vi.spyOn(repos, 'closeDialog').mockImplementation(() => {});
		await click(button(tool(el, 'Azure DevOps'), 'Type it in the terminal'));
		expect(close).toHaveBeenCalledWith('settings');
		expect(add).toHaveBeenCalledWith(null, 'az login');
	});

	test('the copy button copies the command', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const el = await start();
		await click(find(tool(el, 'Azure DevOps'), '.cmd button'));
		expect(writeText).toHaveBeenCalledWith('az login');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Copied' });
	});

	test('a tool that is missing shows how to install it here, and opens its install page; nothing is installed for you', async () => {
		const el = await start();
		expect(words(find(tool(el, 'GitLab'), '.head')!)).toBe('GitLab glab Not installed');
		expect(commands(el, 'GitLab')).toEqual(['brew install glab']);
		w.on('plugin:opener|open_url', () => undefined);
		await click(button(tool(el, 'GitLab'), 'Install page'));
		expect(w.sent('plugin:opener|open_url').at(-1)!.args.url).toBe('https://gitlab.com/gitlab-org/cli#installation');
		expect(w.calls.map((c) => c.cmd).filter((c) => /install/i.test(c))).toEqual([]);
	});

	test('a missing Azure CLI also names the extension it needs', async () => {
		const el = await start('MacIntel', [{ ...TOOLS[1], installed: false }]);
		expect(commands(el, 'Azure DevOps')).toEqual(['brew install azure-cli', 'az extension add --name azure-devops']);
	});

	test('on Windows the install line is winget\'s', async () => {
		const el = await start('Win32');
		expect(commands(el, 'GitLab')).toEqual(['winget install --id GLab.GLab']);
	});

	test('on Linux there is no one line: only the install page', async () => {
		const el = await start('Linux x86_64');
		expect(commands(el, 'GitLab')).toEqual([]);
		expect(all(tool(el, 'GitLab'), 'ml-button').map((b) => words(b))).toEqual(['Install page']);
	});

	test('"Check again" asks the tools again', async () => {
		const el = await start();
		await click(button(find(el, '.end')!, 'Check again'));
		expect(w.sent('host_clis').length).toBe(2);
	});

	test('a tool the app has no instructions for is left out', async () => {
		const el = await start('MacIntel', [...TOOLS, { ...TOOLS[0], provider: 'gitea' as never, name: 'Gitea' }]);
		expect(all(el, '.tool .head b').map((b) => b.textContent)).toEqual(['GitHub', 'Azure DevOps', 'GitLab', 'Jira']);
	});
});

describe('hidden notices', () => {
	test('can be brought back, once some were hidden', async () => {
		const el = await start();
		expect(all(find(el, '.end')!, 'ml-button').map((b) => words(b))).toEqual(['Check again']);
		work.dismiss('gh');
		await settle();
		await click(button(find(el, '.end')!, 'Show hidden notices again'));
		expect(work.dismissed()).toEqual([]);
		expect(JSON.parse(localStorage.getItem('studio.notices.dismissed')!)).toEqual([]);
	});
});

describe('Jira for the open repository', () => {
	/** Types into an `ml-input` and leaves it, which is when the field is taken. */
	async function fill(input: Element, value: string): Promise<void> {
		const inner = find<HTMLInputElement>(input, 'input')!;
		inner.value = value;
		inner.dispatchEvent(new Event('input', { bubbles: true }));
		inner.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
	}

	test('is named after the repository, and empty to begin with', async () => {
		const el = await start();
		expect(words(find(el, 'h4')!)).toBe('Jira for harmony');
		expect(all(el, '.pair ml-input').map((i) => find<HTMLInputElement>(i, 'input')!.value)).toEqual(['', '']);
	});

	test('the site and the project key are kept for this repository, tidied', async () => {
		const el = await start();
		const [site, project] = all(el, '.pair ml-input');
		await fill(site, 'https://team.atlassian.net/');
		await fill(project, 'har');
		expect(JSON.parse(localStorage.getItem('studio.jira')!)).toEqual({ '/Users/demo/Source/harmony': { site: 'team.atlassian.net', project: 'HAR' } });
		expect(work.jiraConfig()).toEqual({ site: 'team.atlassian.net', project: 'HAR' });
	});

	test('a site typed first is not lost while the key is still empty', async () => {
		const el = await start();
		await fill(all(el, '.pair ml-input')[0], 'team.atlassian.net');
		expect(work.jiraConfig()).toBeNull();
		expect(find<HTMLInputElement>(all(el, '.pair ml-input')[0], 'input')!.value).toBe('team.atlassian.net');
	});

	test('no token is asked for', async () => {
		const el = await start();
		expect(all(el, '.pair ml-input').map((i) => i.getAttribute('label'))).toEqual(['Site', 'Project key']);
	});
});
