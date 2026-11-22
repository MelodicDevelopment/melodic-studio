/**
 * A task's pipeline: Plan → Code → Review → Test → Fix → Ship. Code, Review, Test and Fix loop until the
 * review has nothing that blocks and every test passes; after `MAX_FIXES` fixes it stops and asks. The user
 * is asked twice in an ordinary run: to approve the plan, and to ship (merge or open a pull request).
 *
 * This module is the part with no side effects: the shape of the state kept on a session, the kinds of
 * work, where a pipeline stands, and what a test run printed. `services/pipeline.store.ts` drives it.
 */
import type { Finding } from '../services/ai-prompts.ts';

export type StepName = 'plan' | 'code' | 'review' | 'test' | 'fix' | 'ship';
/** The steps Claude does, which each have a model. */
export type ClaudeStep = 'plan' | 'code' | 'review' | 'fix';
export type WorkKind = 'quick' | 'bug' | 'feature' | 'chore';
/** next: not reached. run: going now. done. warn: ran and found something (failing tests, review findings). you: waiting on the user. skip: not part of this kind of work. */
export type StepState = 'next' | 'run' | 'done' | 'warn' | 'you' | 'skip';
export type WaitReason = 'approve' | 'ship' | 'limit' | 'halted';

export const STEPS: StepName[] = ['plan', 'code', 'review', 'test', 'fix', 'ship'];
export const STEP_LABELS: Record<StepName, string> = { plan: 'Plan', code: 'Code', review: 'Review', test: 'Test', fix: 'Fix', ship: 'Ship' };
/** The board's columns: the six steps, then Done. */
export const COLUMNS = [...STEPS.map((s) => STEP_LABELS[s]), 'Done'];
/** Fixes before it stops and asks. */
export const MAX_FIXES = 3;

export const MODELS = [
	{ id: 'opus', name: 'Opus' },
	{ id: 'sonnet', name: 'Sonnet' },
	{ id: 'haiku', name: 'Haiku' },
];
export const DEFAULT_MODELS: Record<ClaudeStep, string> = { plan: 'sonnet', code: 'sonnet', review: 'haiku', fix: 'sonnet' };

export interface KindInfo {
	id: WorkKind;
	name: string;
	about: string;
	/** Steps this kind leaves out. */
	skips: StepName[];
	/** The plan is approved by the user (false: it approves itself and coding starts). */
	planGate: boolean;
}

export const KINDS: KindInfo[] = [
	{ id: 'quick', name: 'Quick fix', about: 'No plan, no review: code and test until green, then you ship.', skips: ['plan', 'review'], planGate: false },
	{ id: 'bug', name: 'Bug', about: 'A short plan you approve, then the loop until every test passes.', skips: [], planGate: true },
	{ id: 'feature', name: 'Feature', about: 'A full plan with questions, then the loop until every test passes.', skips: [], planGate: true },
	{ id: 'chore', name: 'Chore', about: 'The plan approves itself; the review checks nothing changed in behaviour.', skips: [], planGate: false },
];

export function kindOf(id: WorkKind): KindInfo {
	return KINDS.find((k) => k.id === id) ?? KINDS[2];
}

export interface StepRecord {
	state: StepState;
	/** What happened, one or two sentences. Text from Claude or from a program: shown as text only. */
	summary: string;
	/** Details under it: files, failing tests, findings. */
	lines: string[];
	/** Dollars spent on it so far (Claude Code's own totals). */
	cost: number;
}

export interface TestOutcome {
	ok: boolean;
	/** "41 passed, 1 failed", or what can be said without counts. */
	summary: string;
	/** Names of failing tests, as the runner printed them. */
	failures: string[];
	/** The commands that ran. */
	commands: string[];
	/** The end of what the failing runs printed: what Fix is given. */
	output: string;
	/** No test target was found: the step counts as passed. */
	none: boolean;
}

export interface Pipeline {
	kind: WorkKind;
	/** Where it is: a step, or done once shipped. */
	step: StepName | 'done';
	/** The step is waiting on the user: the plan to approve, the ship, a stop, the fix limit. */
	waiting: boolean;
	/** What it is waiting for, in words; null when not waiting. */
	note: string | null;
	/** Why it waits, which decides the buttons: the plan to approve, the ship, the fix limit, or a stop or failure to carry on from. */
	reason?: WaitReason | null;
	/** The session's cost when the running Claude step started: what tells that step's share. */
	mark?: number;
	/** Fixes done so far, and how many it may do before it asks (raised by "One more round"). */
	fixes: number;
	allowedFixes: number;
	models: Partial<Record<ClaudeStep, string>>;
	steps: Record<StepName, StepRecord>;
	/** The plan as Claude wrote it (Markdown, shown through rich-text). */
	plan: string | null;
	/** The last review's findings. */
	findings: Finding[];
	tests: TestOutcome | null;
	/** How the last push went, in words. */
	pushed: string | null;
}

export function modelFor(p: Pipeline, step: ClaudeStep): string {
	return p.models[step] || DEFAULT_MODELS[step];
}

export function newPipeline(kind: WorkKind, models: Partial<Record<ClaudeStep, string>> = {}): Pipeline {
	const info = kindOf(kind);
	const steps = Object.fromEntries(STEPS.map((s) => [s, { state: info.skips.includes(s) ? 'skip' : 'next', summary: '', lines: [], cost: 0 } satisfies StepRecord])) as unknown as Record<StepName, StepRecord>;
	return { kind, step: info.skips.includes('plan') ? 'code' : 'plan', waiting: false, note: null, fixes: 0, allowedFixes: MAX_FIXES, models: { ...models }, steps, plan: null, findings: [], tests: null, pushed: null };
}

/** The pipeline with one step changed. */
export function withStep(p: Pipeline, step: StepName, change: Partial<StepRecord>): Pipeline {
	return { ...p, steps: { ...p.steps, [step]: { ...p.steps[step], ...change } } };
}

/** Its column on the board: 0 to 5 for the steps, 6 for Done. */
export function columnOf(p: Pipeline): number {
	return p.step === 'done' ? 6 : STEPS.indexOf(p.step);
}

/**
 * Findings that send the work back to Fix. A bug always does. A risk does only before the first fix: a
 * review finds new maybe-problems every round, and chasing them never ends (seen in the first real run).
 * After that they are listed for the user at Ship. Nits never hold anything up.
 */
export function blocking(findings: Finding[], fixes = 0): Finding[] {
	return findings.filter((f) => f.severity === 'bug' || (f.severity === 'risk' && fixes === 0));
}

/** Findings worth handing to a fix that runs anyway: bugs and risks, not nits. */
export function worthFixing(findings: Finding[]): Finding[] {
	return findings.filter((f) => f.severity !== 'nit');
}

/** After the review and the tests of a round: fix again, ask the user, or ship. */
export function afterChecks(p: Pipeline): 'fix' | 'ask' | 'ship' {
	const clean = (p.tests?.ok ?? true) && blocking(p.findings, p.fixes).length === 0;
	if (clean) {
		return 'ship';
	}
	return p.fixes < p.allowedFixes ? 'fix' : 'ask';
}

/** The loop in words, for the bracket under the track. */
export function loopWords(p: Pipeline): string {
	if (p.step === 'plan') {
		return 'After the plan: Code → Review → Test → Fix, until every test passes';
	}
	if (p.step === 'ship' || p.step === 'done') {
		return p.fixes ? `Loop finished after ${p.fixes} ${p.fixes === 1 ? 'fix' : 'fixes'}: every test passes` : 'Loop finished first time: every test passes';
	}
	if (p.step === 'fix' || p.fixes) {
		return `Fix ${Math.max(1, p.fixes)} of ${p.allowedFixes} · after ${p.allowedFixes} it asks you`;
	}
	return 'Code → Review → Test → Fix until every test passes · after 3 fixes it asks you';
}

function count(text: string, re: RegExp): number | null {
	let total: number | null = null;
	for (const m of text.matchAll(re)) {
		total = (total ?? 0) + Number(m[1]);
	}
	return total;
}

/**
 * What a test run printed, read for the totals and the names of what failed. Knows the summaries of
 * jest, vitest, node --test, cargo test, pytest, go test and dotnet test; anything else is said by its exit code.
 */
export function readTestOutput(output: string, ok: boolean, code: number | null = null): { summary: string; failures: string[] } {
	const text = output.replace(/\x1b\[[0-9;]*m/g, '');
	let passed: number | null = null;
	let failed: number | null = null;
	// jest: "Tests:       1 failed, 41 passed, 42 total"
	const jest = text.match(/^Tests:\s+(.*\btotal)\s*$/m);
	// vitest: " Tests  1 failed | 41 passed (42)"
	const vitest = text.match(/^\s*Tests\s+(.*\(\d+\))\s*$/m);
	const line = jest?.[1] ?? vitest?.[1];
	if (line) {
		passed = Number(line.match(/(\d+) passed/)?.[1] ?? 0);
		failed = Number(line.match(/(\d+) failed/)?.[1] ?? 0);
	}
	if (passed === null) {
		// cargo, once per test binary: "test result: FAILED. 41 passed; 1 failed; 0 ignored"
		const cp = count(text, /test result: \w+\. (\d+) passed/g);
		if (cp !== null) {
			passed = cp;
			failed = count(text, /test result: \w+\. \d+ passed; (\d+) failed/g) ?? 0;
		}
	}
	if (passed === null) {
		// node --test: "# pass 41" / "# fail 1" (TAP), "ℹ pass 41" / "ℹ fail 1" (its default reporter)
		const np = text.match(/^(?:#|ℹ) pass (\d+)$/m);
		if (np) {
			passed = Number(np[1]);
			failed = Number(text.match(/^(?:#|ℹ) fail (\d+)$/m)?.[1] ?? 0);
		}
	}
	if (passed === null) {
		// pytest: "==== 1 failed, 41 passed in 2.31s ===="
		const py = text.match(/^=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s(?: \([^)]*\))? =+$/m);
		if (py) {
			passed = Number(py[1].match(/(\d+) passed/)?.[1] ?? 0);
			failed = Number(py[1].match(/(\d+) failed/)?.[1] ?? 0) + Number(py[1].match(/(\d+) errors?/)?.[1] ?? 0);
		}
	}
	if (passed === null) {
		// dotnet: "Failed!  - Failed:     1, Passed:    41, Skipped: 0, Total: 42"
		const dp = count(text, /Passed:\s+(\d+)/g);
		const df = count(text, /(?:Failed!|Passed!)\s+-\s+Failed:\s+(\d+)/g);
		if (dp !== null && df !== null) {
			passed = dp;
			failed = df;
		}
	}
	const failures = new Set<string>();
	const add = (name: string | undefined): void => {
		const n = name?.trim();
		if (n && failures.size < 10) {
			failures.add(n.slice(0, 200));
		}
	};
	for (const m of text.matchAll(/^\s*● (.+?)\s*$/gm)) add(m[1]); // jest
	for (const m of text.matchAll(/^\s*(?:×|✕|FAIL)\s+(.+?)(?:\s+\d+m?s)?\s*$/gm)) add(m[1]); // vitest, jest's per-file line
	for (const m of text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) add(m[1]); // cargo
	for (const m of text.matchAll(/^FAILED (\S+)(?: - .*)?$/gm)) add(m[1]); // pytest
	for (const m of text.matchAll(/^\s*--- FAIL: (\S+)/gm)) add(m[1]); // go
	for (const m of text.matchAll(/^\s*Failed (\S+) \[/gm)) add(m[1]); // dotnet
	for (const m of text.matchAll(/^\s*not ok \d+ - (.+)$/gm)) add(m[1]); // node --test, TAP
	for (const m of text.matchAll(/^\s*✖ (.+?) \([\d.]+m?s\)\s*$/gm)) if (!/^failing tests:?$/i.test(m[1])) add(m[1]); // node --test's own reporter
	if (failed === null && !ok) {
		// go prints no totals: count the failing tests it named.
		const go = [...text.matchAll(/^\s*--- FAIL: /gm)].length;
		if (go) {
			failed = go;
			passed = [...text.matchAll(/^\s*--- PASS: /gm)].length || null;
		}
	}
	let summary: string;
	if (passed !== null || failed !== null) {
		const parts = [`${passed ?? 0} passed`];
		if (failed) {
			parts.push(`${failed} failed`);
		}
		summary = parts.join(', ');
	} else {
		summary = ok ? 'Tests passed' : code === null ? 'Tests did not finish' : `Tests failed (exit code ${code})`;
	}
	// A runner that exits non-zero with every test passing failed for another reason (a compile error, a crash).
	if (!ok && !failed && (passed !== null || failed !== null)) {
		summary += code === null ? ', then it did not finish' : `, but it exited with code ${code}`;
	}
	return { summary, failures: [...failures] };
}

/** Several test runs (one per project) as one outcome. */
export function combineTests(runs: { ok: boolean; command: string; output: string; code: number | null }[]): TestOutcome {
	if (!runs.length) {
		return { ok: true, summary: 'No tests found in this project', failures: [], commands: [], output: '', none: true };
	}
	const read = runs.map((r) => ({ ...r, ...readTestOutput(r.output, r.ok, r.code) }));
	const ok = read.every((r) => r.ok);
	return {
		ok,
		summary: read.length === 1 ? read[0].summary : read.map((r) => `${r.command}: ${r.summary}`).join(' · '),
		failures: read.flatMap((r) => r.failures).slice(0, 10),
		commands: read.map((r) => r.command),
		output: read
			.filter((r) => !r.ok)
			.map((r) => `$ ${r.command}\n${r.output.slice(-12_000)}`)
			.join('\n\n'),
		none: false,
	};
}

/** A commit message for a step's work: the brief's title and what it did. */
export function commitMessage(step: 'code' | 'fix', title: string, did: string, fixes: number): string {
	const subject = (step === 'fix' ? `Fix ${fixes}: ${did || title}` : title || did || 'Agent work').replace(/\s+/g, ' ').trim();
	const short = subject.length > 72 ? `${subject.slice(0, 69).trimEnd()}…` : subject;
	return did && !short.includes(did) && !did.startsWith(short.replace(/…$/, '')) ? `${short}\n\n${did}` : short;
}

/** Where a pipeline stands, in a few words, for lists and cards. `running` is whether a Claude turn is going. */
export function statusOf(p: Pipeline, running: boolean): string {
	if (p.waiting) {
		return p.note ?? 'Needs you';
	}
	switch (p.step) {
		case 'plan':
			return 'Writing the plan';
		case 'code':
			return running ? 'Writing the code' : 'Committing and pushing';
		case 'review':
			return p.fixes ? `Reviewing fix ${p.fixes}` : 'Reviewing the change';
		case 'test':
			return 'Running the tests · free';
		case 'fix':
			return running ? `Fix ${p.fixes} of ${p.allowedFixes}` : 'Committing the fix';
		case 'ship':
			return 'Ready to ship';
		default:
			return p.steps.ship.state === 'skip' ? 'Discarded' : 'Shipped';
	}
}

/** The total the pipeline spent: Claude's turns (the session's running total) plus the reviews, which run on their own. */
export function spentOf(p: Pipeline, sessionCost: number): number {
	return sessionCost + p.steps.review.cost;
}
