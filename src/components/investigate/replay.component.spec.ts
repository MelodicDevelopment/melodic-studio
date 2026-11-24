import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentRef, AgentSession, AgentsStore } from '../../services/agents.store';
import type { InvestigationReport } from '../../services/ai-prompts';
import type { RepoStore } from '../../services/repo.store';
import type { ReplayData } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const TREE = `${REPO}.worktrees/investigate-null-discount`;

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
/** What `replay_read` answers: the recording of the run, or why it cannot be read. */
let recording: ReplayData | Error;

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

// happy-dom has no scrollIntoView: Replay keeps the current step in sight with it.
(Element.prototype as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;

beforeEach(async () => {
	forgetElements();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	repos.setTab('agents');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
	recording = RUN;
	w.on('replay_read', () => {
		if (recording instanceof Error) {
			throw { kind: 'error', message: recording.message, paths: [] };
		}
		return recording;
	});
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

/** The file as it ran: every second line is a recording call, which Replay leaves out. */
const PRICING = ['export function applyDiscount(order) {', '\trecord("enter", { order }); // studio-replay', '\tconst customer = order.customer;', '\trecord("line", { customer }); // studio-replay', '\tconst tier = customer.tier;', '\treturn priceFor(tier);', '}'].join('\n');

const event = (kind: string, fn: string, file: string, line: number, values: Record<string, string> = {}): string => JSON.stringify({ event: kind, fn, file, line, values });

const RUN: ReplayData = {
	run: 2,
	events: [
		event('enter', 'getOrder', 'src/orders.ts', 12, { id: '7' }),
		event('enter', 'applyDiscount', 'src/pricing.ts', 2, { order: '{ id: 7 }' }),
		event('line', 'applyDiscount', 'src/pricing.ts', 4, { customer: '<b>null</b>' }),
		event('throw', 'applyDiscount', 'src/pricing.ts', 4),
	].join('\n'),
	files: [{ path: 'src/pricing.ts', text: PRICING }],
};

function report(over: Partial<InvestigationReport> = {}): InvestigationReport {
	return { found: true, summary: 'The order has no customer.', path: [], evidence: [], run: 2, causeSeq: 3, crashSeq: 4, notes: { '3': 'A guest order: `customer` is **null** here, see `src/pricing.ts:3`.' }, test: null, ...over };
}

function session(r: InvestigationReport = report()): AgentSession {
	return {
		id: 's1',
		repoId: REPO,
		title: 'Crash on guest checkout',
		cwd: TREE,
		branch: 'investigate/crash-on-guest-checkout',
		isolated: true,
		mode: 'acceptEdits',
		sessionId: 'claude-s1',
		status: 'idle',
		items: [],
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
		investigation: { summary: 'Crash on guest checkout', description: '', targetId: null, targetName: null, port: null, step: 6, details: {}, thinking: '', approval: null, runs: 2, started: Date.now() - 60_000, ended: Date.now(), report: r, leftover: [], cleanups: 0, checking: false, tab: null },
		check: null,
		brief: null,
		name: null,
	};
}

/** Replay of this investigation's recorded run. */
async function replay(s: AgentSession = session()): Promise<HTMLElement> {
	agents.sessions.set([s]);
	agents.selectedId.set(s.id);
	agents.replaying.set(s.id);
	const el = await mount('ms-replay');
	await settle();
	return el;
}

/** Where it is: "Step 3 of 4". */
const at = (el: HTMLElement): string => read(find(el, 'footer')!).match(/Step \d+ of \d+/)![0];
/** What ran, in order: one row per step. */
const ran = (el: HTMLElement): HTMLElement[] => all(el, 'nav button');
const current = (el: HTMLElement): string => read(ran(el).find((r) => r.getAttribute('aria-current') === 'step')!);
const code = (el: HTMLElement): string[] => all(el, 'main .line').map((l) => `${l.classList.contains('cur') ? '>' : ' '} ${read(l)}`);
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
	const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
	el.dispatchEvent(e);
	return e;
};

describe('Replay', () => {
	test('reads the recording of the run the report names, from the investigation’s worktree', async () => {
		const el = await replay();
		expect(w.sent('replay_read').map((c) => c.args)).toEqual([{ id: REPO, cwd: TREE, run: 2 }]);
		expect(read(el)).toContain('Replay · run 2');
	});

	test('opens on the cause, not on the first step', async () => {
		const el = await replay();
		expect(at(el)).toBe('Step 3 of 4');
		expect(current(el)).toContain('applyDiscount');
		expect(current(el)).toContain('cause');
	});

	test('lists what ran in order, each step with its function and place, and marks the cause and the crash', async () => {
		const el = await replay();
		expect(ran(el).map((r) => read(r))).toEqual(['1 getOrder orders.ts:12', '2 applyDiscount pricing.ts:1', '3 applyDiscount pricing.ts:2 · cause', '4 applyDiscount pricing.ts:2 · crash']);
	});

	test('shows the code as the user has it: the recording lines are gone and the step is on the line it recorded', async () => {
		const el = await replay();
		const shown = code(el);
		expect(shown.some((l) => l.includes('studio-replay'))).toBe(false);
		// The lines around the step, numbered as in the clean file, with what was recorded beside each.
		expect(shown.slice(0, 4)).toEqual(['  1 export function applyDiscount(order) { order = { id: 7 }', '> 2 const customer = order.customer; customer = <b>null</b>', '  3 const tier = customer.tier;', '  4 return priceFor(tier);']);
	});

	test('recorded values are text, whatever the program put in them', async () => {
		const el = await replay();
		expect(find(el, 'main b')).toBeNull();
		expect(read(find(el, 'main')!)).toContain('customer = <b>null</b>');
	});

	test('Claude’s note on the step is shown with its file reference as a link', async () => {
		const el = await replay();
		const followed: AgentRef[] = [];
		agents.follow = async (_s: AgentSession, ref: AgentRef) => void followed.push(ref);
		expect(read(find(el, 'main')!)).toContain('A guest order: customer is null here, see');
		await click(all(el, 'main a').find((a) => a.textContent === 'src/pricing.ts:3')!);
		expect(followed).toEqual([{ kind: 'file', path: 'src/pricing.ts', line: 3, column: null }]);
	});

	test('a click on a step goes there, and the step buttons move one at a time, stopping at the ends', async () => {
		const el = await replay();
		const back = find<HTMLButtonElement>(el, 'button[aria-label="Step back"]')!;
		const forward = find<HTMLButtonElement>(el, 'button[aria-label="Step forward"]')!;
		await click(ran(el)[0]);
		expect(at(el)).toBe('Step 1 of 4');
		expect(back.disabled).toBe(true);
		await click(forward);
		expect(at(el)).toBe('Step 2 of 4');
		await click(ran(el)[3]);
		expect(at(el)).toBe('Step 4 of 4');
		expect(forward.disabled).toBe(true);
		await click(back);
		expect(at(el)).toBe('Step 3 of 4');
	});

	test('a step whose file was not kept says so and still shows what was recorded there', async () => {
		const el = await replay();
		await click(ran(el)[0]);
		expect(read(find(el, 'main')!)).toContain('No copy of orders.ts was kept for this run, so there is no code to show for this step.');
		expect(read(find(el, 'main')!)).toContain('id 7');
		// With no copy there is nothing to open either.
		expect(find(el, 'main a')).toBeNull();
	});

	test('the place of a step opens its file in the Files tab at that line', async () => {
		const el = await replay();
		const opened: unknown[][] = [];
		agents.openFile = async (...args: unknown[]) => void opened.push(args.slice(1));
		await click(find(el, 'main a[title="Open in the Files tab"]'));
		expect(opened).toEqual([['src/pricing.ts', 2]]);
	});

	test('the arrow keys step and never run past the ends', async () => {
		const el = await replay();
		expect(key(el, 'ArrowLeft').defaultPrevented).toBe(true);
		await settle();
		expect(at(el)).toBe('Step 2 of 4');
		key(el, 'ArrowRight');
		key(el, 'ArrowDown');
		key(el, 'ArrowDown');
		key(el, 'ArrowDown');
		await settle();
		expect(at(el)).toBe('Step 4 of 4');
		key(el, 'ArrowUp');
		await settle();
		expect(at(el)).toBe('Step 3 of 4');
	});

	test('a shortcut of the app is left alone', async () => {
		const el = await replay();
		expect(key(el, 'ArrowLeft', { metaKey: true }).defaultPrevented).toBe(false);
		await settle();
		expect(at(el)).toBe('Step 3 of 4');
	});

	test('Space plays and pauses; stepping by hand ends playing', async () => {
		const el = await replay();
		const play = (): HTMLElement => all(el, 'footer button').find((b) => /^(Play|Pause)$/.test(b.getAttribute('aria-label') ?? ''))!;
		expect(play().getAttribute('aria-label')).toBe('Play');
		key(el, ' ');
		await settle();
		expect(play().getAttribute('aria-label')).toBe('Pause');
		key(el, ' ');
		await settle();
		expect(play().getAttribute('aria-label')).toBe('Play');
		await click(play());
		expect(play().getAttribute('aria-label')).toBe('Pause');
		await click(ran(el)[1]);
		expect(play().getAttribute('aria-label')).toBe('Play');
	});

	test('playing moves on a step at a time and stops at the last one; from the end it starts over', async () => {
		const el = await replay();
		vi.useFakeTimers();
		try {
			key(el, ' ');
			await vi.advanceTimersByTimeAsync(1250);
			expect(at(el)).toBe('Step 4 of 4');
			await vi.advanceTimersByTimeAsync(1250);
			expect(find(el, 'footer button[aria-label="Play"]')).not.toBeNull();
			key(el, ' ');
			await vi.advanceTimersByTimeAsync(50);
			expect(at(el)).toBe('Step 1 of 4');
			key(el, ' ');
		} finally {
			vi.useRealTimers();
		}
	});

	test('the timeline names the cause and the crash, and a click goes to either', async () => {
		const el = await replay();
		await click(button(el, 'Crash · step 4'));
		expect(at(el)).toBe('Step 4 of 4');
		await click(button(el, 'Cause · step 3'));
		expect(at(el)).toBe('Step 3 of 4');
		// A dot per step, each saying which step it is.
		expect(all(el, 'footer button[aria-label^="Step "]').map((d) => d.getAttribute('aria-label'))).toEqual(['Step back', 'Step forward', 'Step 1, getOrder line 12', 'Step 2, applyDiscount line 1', 'Step 3, applyDiscount line 2', 'Step 4, applyDiscount line 2']);
	});

	test('a long run gets a slider instead of a dot per step', async () => {
		recording = { run: 2, events: Array.from({ length: 80 }, (_, n) => event('line', `step${n + 1}`, 'src/loop.ts', n + 1)).join('\n'), files: [] };
		const el = await replay(session(report({ causeSeq: null, crashSeq: null, notes: {} })));
		expect(at(el)).toMatch(/of 80$/);
		const slider = find<HTMLInputElement>(el, 'input[type=range]')!;
		expect(slider.max).toBe('79');
		slider.value = '41';
		slider.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(at(el)).toBe('Step 42 of 80');
	});

	test('Report and Escape go back to the report', async () => {
		const el = await replay();
		await press(button(el, 'Report'));
		expect(agents.replaying()).toBeNull();
		agents.replaying.set('s1');
		key(el, 'Escape');
		expect(agents.replaying()).toBeNull();
	});

	test('a run that recorded nothing says so, with the way back', async () => {
		recording = { run: 2, events: '', files: [] };
		const el = await replay();
		expect(read(el)).toContain('This run recorded nothing. Ask Claude in the report to record it again.');
		expect(button(el, 'Report')).not.toBeNull();
	});

	test('a recording that cannot be read says why', async () => {
		recording = new Error('The recording of run 2 is no longer in the worktree');
		const el = await replay();
		expect(read(el)).toContain('The recording of run 2 is no longer in the worktree');
	});

	test('lines of a recording that are not events are skipped, not shown', async () => {
		recording = { ...RUN, events: `not json at all\n${RUN.events}\n{"event":"line"` };
		const el = await replay();
		expect(ran(el).map((r) => read(r).split(' ')[1])).toEqual(['getOrder', 'applyDiscount', 'applyDiscount', 'applyDiscount']);
	});
});
