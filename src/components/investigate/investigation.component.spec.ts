import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentItem, AgentRef, AgentSession, AgentsStore, Investigation } from '../../services/agents.store';
import type { InvestigationReport } from '../../services/ai-prompts';
import type { RepoStore } from '../../services/repo.store';
import type { ChangedFile, InvestigateApproval, WorktreeDiff } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const TREE = `${REPO}.worktrees/investigate-null-discount`;
const BRANCH = 'investigate/nullreferenceexception-in-applydiscount';

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
/** What the worktree holds that the commit it started from does not: the fix. */
let fixDiff: WorktreeDiff | Error;

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
	repos.setTab('agents');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
	fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: [], tooLarge: false };
	w.on('worktree_diff', () => {
		if (fixDiff instanceof Error) {
			throw { kind: 'git', message: fixDiff.message, paths: [] };
		}
		return fixDiff;
	});
	w.on('worktree_list', () => [
		{ path: REPO, branch: 'feature/repeat-mode', head: 'a'.repeat(40), isMain: true, active: true, changes: 0, landed: false },
		{ path: TREE, branch: BRANCH, head: 'c'.repeat(40), isMain: false, active: false, changes: 2, landed: false },
	]);
	// A turn that starts stays started: the demo's own would play out over seconds.
	w.on('agent_start', () => undefined);
});

/** Tags that mark words inside a sentence: nothing is read between them and the words around them. */
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'U', 'A']);

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

function investigation(over: Partial<Investigation> = {}): Investigation {
	return { summary: 'NullReferenceException in ApplyDiscount', description: '', targetId: 'shop-api', targetName: 'Shop.Api · https', port: null, step: 0, details: {}, thinking: '', approval: null, runs: 0, started: Date.now() - 3 * 60_000, ended: null, report: null, leftover: [], cleanups: 0, checking: false, tab: null, ...over };
}

function session(i: Partial<Investigation> = {}, over: Partial<AgentSession> = {}): AgentSession {
	return {
		id: 's1',
		repoId: REPO,
		title: 'NullReferenceException in ApplyDiscount',
		cwd: TREE,
		branch: BRANCH,
		isolated: true,
		mode: 'acceptEdits',
		sessionId: 'claude-s1',
		status: 'running',
		items: [{ kind: 'user', text: 'Investigate the crash' }],
		cost: 0,
		updated: Date.now(),
		kind: 'investigate',
		group: null,
		attempt: 1,
		base: 'b'.repeat(40),
		tools: null,
		unread: false,
		review: false,
		stopped: false,
		investigation: investigation(i),
		check: null,
		brief: null,
		name: null,
		...over,
	};
}

function approval(over: Partial<InvestigateApproval> = {}): InvestigateApproval {
	return { key: 's1', request: 'ask-1', tool: 'run_target', target: 'Shop.Api: https', group: 'Shop.Api', project: 'Shop.Api', command: 'dotnet run --project src/Shop.Api --launch-profile https', port: 5210, method: null, path: null, body: null, touches: 'It writes orders to the local SQLite file in the worktree, nothing else.', ...over };
}

function report(over: Partial<InvestigationReport> = {}): InvestigationReport {
	return {
		found: true,
		summary: 'ApplyDiscount reads customer.Tier before checking that the order has a customer.',
		path: [
			{ fn: 'OrdersController.Get', file: 'src/Shop.Api/Controllers/OrdersController.cs', line: 31, values: [['id', '7']], role: null },
			{ fn: 'PriceService.ApplyDiscount', file: 'src/Shop.Api/Services/PriceService.cs', line: 48, values: [['customer', 'null']], role: 'cause' },
			{ fn: 'Tier.get', file: '', line: null, values: [], role: 'crash' },
		],
		evidence: [
			{ status: 'ruled-out', title: 'The order itself is missing', detail: 'Order 7 **exists**: the lookup returns it.', refs: [] },
			{ status: 'confirmed', title: 'Guest orders have no customer', detail: '', refs: ['src/Shop.Api/Services/PriceService.cs:48', 'the seed data'] },
		],
		run: 2,
		causeSeq: 4,
		crashSeq: 5,
		notes: {},
		test: { name: 'ApplyDiscount_GuestOrder_NoDiscount', failsBefore: true, passesAfter: true },
		...over,
	};
}

const FIX: ChangedFile[] = [
	{ path: 'src/Shop.Api/Services/PriceService.cs', oldPath: null, status: 'modified', diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -48,1 +48,2 @@\n-var tier = order.Customer.Tier;\n+if (order.Customer is null) return price;\n+var tier = order.Customer.Tier;\n' },
	{ path: 'tests/PriceServiceTests.cs', oldPath: null, status: 'untracked', diff: 'diff --git a/y b/y\n--- /dev/null\n+++ b/y\n@@ -0,0 +1,1 @@\n+[Fact] public void ApplyDiscount_GuestOrder_NoDiscount() {}\n' },
];

/** The session's done with a report: its turn has ended and the worktree was checked for leftover recording. */
const concluded = (r: Partial<InvestigationReport> = {}, i: Partial<Investigation> = {}): AgentSession => session({ step: 6, runs: 5, ended: Date.now(), report: report(r), ...i }, { status: 'idle' });

/** The investigation's pane with this session open in it. */
async function pane(s: AgentSession): Promise<HTMLElement> {
	agents.sessions.set([s]);
	agents.selectedId.set(s.id);
	const el = await mount('ms-investigation');
	await settle();
	return el;
}

/** The checklist, as "state: title detail" per step. */
const steps = (el: HTMLElement): string[] => all(el, 'ol li').map((li) => `${li.className}: ${read(li)}`);
/** The card that asks before something runs. */
const card = (el: HTMLElement): HTMLElement | null => find(el, '[role=alertdialog]');

describe('while it investigates', () => {
	test('says what it looks into, that it works in a worktree of its own, and that your files are untouched', async () => {
		const el = await pane(session({ step: 2 }));
		const top = read(find(el, 'header')!);
		expect(top).toContain('Investigating');
		expect(top).toContain('NullReferenceException in ApplyDiscount');
		expect(top).toContain(`worktree ${BRANCH}`);
		expect(top).toContain('Your files are untouched');
		expect(top).not.toContain('its own port');
	});

	test('names the port its copy of the app runs on, once it has started one', async () => {
		const el = await pane(session({ step: 4, port: 5210 }));
		expect(read(find(el, 'header')!)).toContain('its own port 5210');
	});

	test('shows the six steps, with the ones behind it done and what Claude said under each', async () => {
		const el = await pane(session({ step: 3, details: { '1': 'The 500 comes from GET /orders/7.', '2': 'Order 7 is a guest order.' } }));
		expect(steps(el)).toEqual([
			'done: Read the error and the code on its path The 500 comes from GET /orders/7.',
			'done: Find the failing request or input Order 7 is a guest order.',
			'now: Add recording to the functions on the path',
			'todo: Run it again, recording',
			'todo: Narrow down the cause',
			'todo: Write the fix, plus a test that fails without it',
		]);
	});

	test('before Claude has said where it is, it is reading', async () => {
		const el = await pane(session({ step: 0 }));
		expect(steps(el)[0]).toBe('now: Read the error and the code on its path');
	});

	test('shows what Claude thinks so far, as text with its file references as links', async () => {
		const el = await pane(session({ step: 5, thinking: 'The customer is <b>null</b> in `src/Shop.Api/Services/PriceService.cs:48`.' }));
		const followed: AgentRef[] = [];
		agents.follow = async (_s: AgentSession, ref: AgentRef) => void followed.push(ref);
		expect(read(el)).toContain("Claude's thinking so far The customer is <b>null</b> in src/Shop.Api/Services/PriceService.cs:48.");
		expect(find(el, '.side b')).toBeNull();
		await click(find(el, 'a'));
		expect(followed).toEqual([{ kind: 'file', path: 'src/Shop.Api/Services/PriceService.cs', line: 48, column: null }]);
	});

	test('Stop ends its turn', async () => {
		const el = await pane(session({ step: 2 }));
		await press(button(el, 'Stop'));
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual(['s1']);
		expect(read(find(el, 'header')!)).toContain('Investigation stopped');
		expect(button(el, 'Stop')).toBeNull();
	});

	test('the transcript can be looked at instead of the checklist, with Studio’s tools named plainly and JSON left as it is', async () => {
		const items: AgentItem[] = [
			{ kind: 'user', text: 'Investigate the crash' },
			{ kind: 'tool', text: 'Read', detail: 'src/Shop.Api/Services/PriceService.cs' },
			{ kind: 'tool', text: 'mcp__studio__run_target', detail: 'Shop.Api: https' },
			{ kind: 'text', text: '{"found": true, "summary": "<b>x</b>"}' },
		];
		const el = await pane(session({ step: 4 }, { items }));
		expect(read(el)).not.toContain('run_target');
		await press(button(el, 'Transcript'));
		const shown = read(find(el, '.log')!);
		expect(shown).toBe('Investigate the crash Read src/Shop.Api/Services/PriceService.cs run_target Shop.Api: https {"found": true, "summary": "<b>x</b>"}');
		expect(find(el, '.log b > b, .log pre b')).toBeNull();
		expect(all(el, 'ol li')).toEqual([]);
		await press(button(el, 'Hide transcript'));
		expect(all(el, 'ol li').length).toBe(6);
	});

	test('shows nothing for a session that is not an investigation, and the investigation when one is opened', async () => {
		agents.sessions.set([session({}, { id: 'task', kind: 'task', investigation: null }), session({ step: 2 })]);
		agents.selectedId.set('task');
		const el = await mount('ms-investigation');
		expect(read(el)).toBe('');
		agents.selectedId.set('s1');
		await settle();
		expect(read(el)).toContain('Investigating');
	});
});

describe('the approval card', () => {
	test('asks before the app is run: what, from where, on which port, with the command and what Claude says it touches', async () => {
		const el = await pane(session({ step: 4, approval: approval() }));
		const asked = card(el)!;
		expect(asked.getAttribute('aria-label')).toBe('Claude wants to run Shop.Api');
		const said = read(asked);
		expect(said).toContain('This starts a copy of Shop.Api from the worktree on port 5210');
		expect(said).toContain('so it does not collide with the one you are running.');
		expect(find(asked, 'pre')!.textContent).toBe('dotnet run --project src/Shop.Api --launch-profile https');
		expect(said).toContain('What it touches, according to Claude: It writes orders to the local SQLite file in the worktree, nothing else.');
		expect(all(asked, 'ml-button').map((b) => read(b))).toEqual(['Allow once', 'Always allow for Shop.Api · https', "Don't run"]);
	});

	test('the step it is on waits for your OK', async () => {
		const el = await pane(session({ step: 4, approval: approval() }));
		expect(steps(el)[3]).toBe('waiting: Run it again, recording Waiting for your OK');
	});

	test('a request shows its method, path and body, and that it goes to the worktree’s copy', async () => {
		const el = await pane(session({ step: 4, port: 5210, approval: approval({ tool: 'http_request', command: null, method: 'POST', path: '/orders', body: '{"customerId": null}' }) }));
		const asked = card(el)!;
		expect(asked.getAttribute('aria-label')).toBe('Claude wants to send a request to its copy of the app');
		expect(read(asked)).toContain('It goes to the copy running from the worktree on port 5210');
		expect(read(asked)).toContain('not to the one you are running.');
		expect(find(asked, 'pre')!.textContent).toBe('POST /orders\n\n{"customerId": null}');
	});

	test('tests are asked for by their project and command', async () => {
		const el = await pane(session({ step: 6, approval: approval({ tool: 'run_tests', project: 'Shop.Tests', target: 'Shop.Tests', command: 'dotnet test tests/Shop.Tests', port: null }) }));
		const asked = card(el)!;
		expect(asked.getAttribute('aria-label')).toBe('Claude wants to run Shop.Tests');
		expect(read(asked)).toContain('This runs the tests in the worktree, with its recording in place.');
		expect(find(asked, 'pre')!.textContent).toBe('dotnet test tests/Shop.Tests');
	});

	test('says so when Claude did not say what it touches', async () => {
		const el = await pane(session({ step: 4, approval: approval({ touches: null }) }));
		expect(read(card(el)!)).toContain('Claude did not say what this touches outside the worktree.');
	});

	test('what the program and Claude put on the card is text', async () => {
		const el = await pane(session({ step: 4, approval: approval({ project: '<img src=x onerror=alert(1)>', command: '<script>alert(2)</script>', touches: '<b>nothing</b>, honest' }) }));
		expect(all(el, 'img, script').length).toBe(0);
		expect(find(card(el)!, '.touches b > b, .touches b + b')).toBeNull();
		expect(read(card(el)!)).toContain('<b>nothing</b>, honest');
		expect(find(card(el)!, 'pre')!.textContent).toBe('<script>alert(2)</script>');
	});

	test('Allow once lets that one thing run', async () => {
		const el = await pane(session({ step: 4, port: 5210, approval: approval({ tool: 'http_request', method: 'GET', path: '/orders/7' }) }));
		await press(button(card(el)!, 'Allow once'));
		expect(w.sent('investigate_answer').map((c) => c.args)).toEqual([{ request: 'ask-1', allow: true }]);
		expect(card(el)).toBeNull();
		expect(localStorage.getItem('studio.investigate.allow')).toBeNull();
	});

	test("Don't run tells Claude no, and nothing is started", async () => {
		const el = await pane(session({ step: 4, approval: approval() }));
		await press(button(card(el)!, "Don't run"));
		expect(w.sent('investigate_answer').map((c) => c.args)).toEqual([{ request: 'ask-1', allow: false }]);
		expect(w.sent('investigate_start')).toEqual([]);
		expect(card(el)).toBeNull();
		// It carries on without it: the step is no longer waiting.
		expect(steps(el)[3]).toBe('now: Run it again, recording');
	});

	test('running the app is allowed through the same question; the buttons say whether for once or for good', async () => {
		const el = await pane(session({ step: 4, approval: approval() }));
		const allowed: unknown[][] = [];
		agents.allow = async (...args: unknown[]) => void allowed.push(args);
		await press(button(card(el)!, 'Allow once'));
		await press(button(card(el)!, /^Always allow for/));
		expect(allowed).toEqual([['s1'], ['s1', true]]);
	});

	test('Always allow is remembered for that target, and the next thing it asks runs without a card', async () => {
		const el = await pane(session({ step: 4, port: 5210, approval: approval({ tool: 'http_request', method: 'GET', path: '/orders/7' }) }));
		await press(button(card(el)!, /^Always allow for/));
		expect(JSON.parse(localStorage.getItem('studio.investigate.allow')!)).toEqual({ [REPO]: ['Shop.Api · https'] });
		expect(w.sent('investigate_answer').map((c) => c.args)).toEqual([{ request: 'ask-1', allow: true }]);
		w.emit('investigate-approval', approval({ request: 'ask-2', tool: 'http_request', method: 'GET', path: '/orders/8' }));
		await settle();
		expect(w.sent('investigate_answer').map((c) => c.args)).toEqual([
			{ request: 'ask-1', allow: true },
			{ request: 'ask-2', allow: true },
		]);
		expect(card(el)).toBeNull();
	});

	test('a question that arrives while it runs puts the card up', async () => {
		const el = await pane(session({ step: 3 }));
		expect(card(el)).toBeNull();
		w.emit('investigate-approval', approval());
		await settle();
		expect(card(el)!.getAttribute('aria-label')).toBe('Claude wants to run Shop.Api');
	});
});

describe('when it ended without a report', () => {
	test('says how it ended, shows the last thing said, and takes word on how to carry on', async () => {
		const el = await pane(session({ step: 3 }, { status: 'failed', items: [{ kind: 'user', text: 'Investigate' }, { kind: 'error', text: 'Claude Code exited with an error.' }] }));
		expect(read(find(el, 'header')!)).toContain('The investigation failed');
		expect(read(el)).toContain('Claude Code exited with an error.');
		const follow = find<HTMLInputElement>(el, 'form input')!;
		expect(follow.placeholder).toBe('Tell Claude how to carry on, or what it missed');
		follow.value = 'Try the guest checkout';
		follow.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		find(el, 'form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(String(sent[0].args.prompt)).toContain('Try the guest checkout');
		// Still an investigation: in its worktree, with its own rules and tools, not the user's settings.
		expect(sent[0].args).toMatchObject({ cwd: TREE, resume: 'claude-s1' });
		expect(sent[0].args.options).toMatchObject({ investigate: { target: 'shop-api' } });
	});

	test('a stopped one says stopped, and one that just ended says there is no report', async () => {
		const el = await pane(session({ step: 3 }, { status: 'idle', stopped: true }));
		expect(read(find(el, 'header')!)).toContain('Investigation stopped');
		agents.sessions.set([session({ step: 3 }, { status: 'idle' })]);
		await settle();
		expect(read(find(el, 'header')!)).toContain('Investigation ended without a report');
	});

	test('nothing can be asked with an empty box', async () => {
		const el = await pane(session({ step: 3 }, { status: 'idle', stopped: true }));
		expect(find<HTMLButtonElement>(el, 'form button')!.disabled).toBe(true);
		find(el, 'form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(w.sent('agent_start')).toEqual([]);
	});
});

describe('the report', () => {
	test('leads with the verdict, how long it took and how often it ran, then the cause', async () => {
		const el = await pane(concluded());
		expect(read(find(el, 'header')!)).toBe('Cause found · 3 min · 5 runs ApplyDiscount reads customer.Tier before checking that the order has a customer. Transcript');
	});

	test('with no cause found it says so and asks what else to try', async () => {
		const el = await pane(concluded({ found: false, summary: 'The crash could not be reproduced.', path: [], evidence: [], test: null, run: null }, { runs: 1 }));
		expect(read(find(el, 'header')!)).toContain('No cause found · 3 min · 1 run');
		expect(find<HTMLInputElement>(el, 'form input')!.placeholder).toBe('Tell Claude what else to try');
		expect(read(el)).toContain('Claude listed no evidence. Ask it below what it tested.');
	});

	test('shows the path it took, with the values recorded and where the cause and the crash are', async () => {
		const el = await pane(concluded());
		const cards = all(el, '.path > div').map((c) => read(c));
		expect(cards).toEqual(['OrdersController.Get OrdersController.cs:31 id = 7', 'PriceService.ApplyDiscount PriceService.cs:48 customer = null The cause', 'Tier.get The crash']);
	});

	test('a step of the path opens its file at the line; one without a file is not a link', async () => {
		const el = await pane(concluded());
		const opened: unknown[][] = [];
		agents.openFile = async (...args: unknown[]) => void opened.push(args.slice(1));
		await click(all(el, '.path a')[1]);
		expect(opened).toEqual([['src/Shop.Api/Services/PriceService.cs', 48]]);
		expect(all(el, '.path a').map((a) => a.textContent)).toEqual(['OrdersController.Get', 'PriceService.ApplyDiscount']);
	});

	test('lists the evidence with what each thing showed', async () => {
		const el = await pane(concluded());
		const rows = all(el, '.evidence > div').map((r) => read(r));
		expect(rows).toEqual(['Ruled out The order itself is missing Order 7 exists: the lookup returns it.', 'Confirmed Guest orders have no customer src/Shop.Api/Services/PriceService.cs:48 the seed data']);
	});

	test('a place named in the evidence is a link only when it reads as a file', async () => {
		const el = await pane(concluded());
		const opened: unknown[][] = [];
		agents.openFile = async (...args: unknown[]) => void opened.push(args.slice(1));
		const refs = all(el, '.evidence a');
		expect(refs.map((a) => a.textContent)).toEqual(['src/Shop.Api/Services/PriceService.cs:48']);
		await click(refs[0]);
		expect(opened).toEqual([['src/Shop.Api/Services/PriceService.cs', 48]]);
	});

	test('everything in it that Claude or the program wrote is text', async () => {
		const el = await pane(
			concluded({
				summary: '<img src=x onerror=alert(1)>',
				path: [{ fn: '<script>alert(2)</script>', file: 'src/a.cs', line: 1, values: [['<b>name</b>', '<i>value</i>']], role: 'cause' }],
				evidence: [{ status: 'confirmed', title: '<u>title</u>', detail: '<s>detail</s>', refs: ['<a href="x">ref</a>'] }],
				test: { name: '<em>test</em>', failsBefore: true, passesAfter: true },
			})
		);
		// (An icon is an `<i>` of its own; none of these is.)
		expect(all(el, 'img, script, i:not([aria-hidden]), u, s, em, a[href="x"]').length).toBe(0);
		const shown = read(el);
		for (const raw of ['<img src=x onerror=alert(1)>', '<script>alert(2)</script>', '<b>name</b> = <i>value</i>', '<u>title</u>', '<s>detail</s>', '<a href="x">ref</a>', '<em>test</em>']) {
			expect(shown).toContain(raw);
		}
	});

	test('Open Replay is there when a run was recorded, and opens it', async () => {
		const el = await pane(concluded());
		await press(button(el, 'Open Replay'));
		expect(agents.replaying()).toBe('s1');
		expect(find(el, 'ms-replay')).not.toBeNull();
	});

	test('there is no Replay without a recording', async () => {
		const el = await pane(concluded({ run: null }));
		expect(button(el, 'Open Replay')).toBeNull();
	});

	test('a follow-up may run and record again, so the checklist comes back while it does', async () => {
		const el = await pane(concluded());
		const follow = find<HTMLInputElement>(el, 'form input')!;
		expect(follow.placeholder).toBe('Ask a follow-up: Claude may run and record again');
		follow.value = 'Does it also happen for refunds?';
		follow.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		find(el, 'form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		const prompt = String(w.sent('agent_start')[0].args.prompt);
		expect(prompt).toContain('[investigate-follow-up]');
		expect(prompt).toContain('Does it also happen for refunds?');
		expect(read(find(el, 'header')!)).toContain('Investigating');
		expect(all(el, 'ol li').length).toBe(6);
	});
});

describe('the fix', () => {
	test('is the worktree’s diff against where it started, with the test that proves it', async () => {
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX, tooLarge: false };
		const el = await pane(concluded());
		expect(w.sent('worktree_diff').at(-1)!.args).toEqual({ id: REPO, path: TREE, base: 'b'.repeat(40) });
		const fix = find(el, '.fix')!;
		expect(all(fix, '.dhead').map((h) => read(h))).toEqual(['src/Shop.Api/Services/PriceService.cs +2 −1', 'tests/PriceServiceTests.cs +1 −0']);
		expect(read(find(fix, '.test')!)).toBe('New test ApplyDiscount_GuestOrder_NoDiscount : fails before, passes after');
		expect(read(fix)).toContain('The recording Claude added is gone. Only the fix and the test are left.');
	});

	test('says so when the test was not seen failing before or passing after', async () => {
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX, tooLarge: false };
		const el = await pane(concluded({ test: { name: 'T', failsBefore: false, passesAfter: false } }));
		expect(read(find(el, '.fix .test')!)).toBe('New test T : not seen failing before, not seen passing after');
	});

	test('says so when Claude added no test', async () => {
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX.slice(0, 1), tooLarge: false };
		const el = await pane(concluded({ test: null }));
		expect(read(find(el, '.fix')!)).toContain('Claude did not add a test for this.');
		expect(read(find(el, '.fix')!)).toContain('Only the fix is left.');
	});

	test('Accept fix asks the session pane for its Merge dialog; nothing is committed or merged by the click', async () => {
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX, tooLarge: false };
		const el = await pane(concluded());
		let asked = 0;
		el.addEventListener('accept', () => void asked++);
		await press(button(el, 'Accept fix'));
		expect(asked).toBe(1);
		expect(w.calls.map((c) => c.cmd).filter((c) => /^(investigate_commit|merge_branch)$/.test(c))).toEqual([]);
	});

	test('with nothing changed there is no fix to accept, and it says to ask for one', async () => {
		const el = await pane(concluded({ test: null }));
		expect(read(find(el, '.fix')!)).toContain('Claude changed nothing in the code. Ask it below to write the fix.');
		expect(disabled(button(el, 'Accept fix'))).toBe(true);
		expect(disabled(button(el, 'Review in Changes'))).toBe(true);
	});

	test('Review in Changes goes to its worktree, and Discard asks the session pane to confirm', async () => {
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX, tooLarge: false };
		const el = await pane(concluded());
		let discard = '';
		el.addEventListener('discard', (e) => void (discard = (e as CustomEvent).detail));
		await press(button(el, 'Discard'));
		expect(discard).toBe('s1');
		expect(w.sent('worktree_remove')).toEqual([]);
		await press(button(el, 'Review in Changes'));
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([TREE]);
		expect(repos.tab()).toBe('changes');
	});

	test('while recording is left in the code the fix is not offered', async () => {
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX, tooLarge: false };
		const el = await pane(concluded({}, { leftover: ['src/Shop.Api/Services/PriceService.cs', 'src/Shop.Api/StudioReplay.cs'], cleanups: 2 }));
		const fix = find(el, '.fix')!;
		expect(read(fix)).toContain('Recording is still in 2 files (PriceService.cs, StudioReplay.cs), so the fix is not offered yet.');
		expect(button(fix, 'Accept fix')).toBeNull();
		expect(read(fix)).not.toContain('The recording Claude added is gone.');
		expect(['Ask Claude to remove it', 'Review in Changes', 'Discard'].map((label) => !!button(fix, label))).toEqual([true, true, true]);
	});

	test('Ask Claude to remove it sends it back to take the recording out, and nothing else', async () => {
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX, tooLarge: false };
		const el = await pane(concluded({}, { leftover: ['src/Shop.Api/StudioReplay.cs'], cleanups: 2 }));
		await press(button(el, 'Ask Claude to remove it'));
		const prompt = String(w.sent('agent_start')[0].args.prompt);
		expect(prompt).toContain('Remove every line that ends in the studio-replay marker and delete the helper file, changing nothing else.');
	});

	test('says so when the worktree can no longer be read', async () => {
		fixDiff = new Error('fatal: not a git repository');
		const el = await pane(concluded());
		expect(read(find(el, '.fix')!)).toContain('The worktree could not be read. It may have been removed.');
		expect(disabled(button(el, 'Accept fix'))).toBe(true);
	});

	test('is read again when another turn of it has ended', async () => {
		const el = await pane(concluded({ test: null }));
		const before = w.sent('worktree_diff').length;
		fixDiff = { base: 'b'.repeat(40), head: 'c'.repeat(40), files: FIX, tooLarge: false };
		agents.sessions.set([{ ...concluded(), updated: Date.now() + 1000, investigation: { ...concluded().investigation!, ended: Date.now() + 1000 } }]);
		await settle();
		await settle();
		expect(w.sent('worktree_diff').length).toBe(before + 1);
		expect(disabled(button(el, 'Accept fix'))).toBe(false);
	});
});

test('how long it took is said in words', async () => {
	const { took } = await import('./investigation.component');
	expect([20_000, 60_000, 3 * 60_000 + 20_000, 59 * 60_000, 65 * 60_000, 125 * 60_000].map(took)).toEqual(['under a minute', '1 min', '3 min', '59 min', '1 h 5 min', '2 h 5 min']);
});
