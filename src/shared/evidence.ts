/**
 * The evidence for a task's change: why it can be trusted, and where it cannot. Made from what the pipeline
 * already knows (`shared/pipeline.ts`: the tests, the review, the rounds of the loop, what the checks looked
 * at) and the language servers' check of the change. One verdict, the proofs under it, and, said as loudly
 * as what passed, what nothing checked (`gaps`) and whether the work moved after it was checked (`stale`).
 *
 * No side effects and nothing asked of anyone: `evidenceOf` only reads. Every text in it that comes from a
 * program or from Claude (test names, findings, compiler messages, file names) is shown as text only.
 */
import { kindOf, type Pipeline, type Round } from './pipeline.ts';

/** ok: checked and fine. warn: fine, with something left to the user. bad: it found a problem. none: nothing looked. run: looking now. */
export type Mark = 'ok' | 'warn' | 'bad' | 'none' | 'run';

export interface ProofLine {
	text: string;
	/** More about it, on a line of its own. */
	detail?: string;
	/** A place in the task's checkout the line is about. */
	place?: { path: string; line: number };
}

export interface Proof {
	id: 'tests' | 'review' | 'types' | 'loop' | 'change';
	mark: Mark;
	title: string;
	/** The proof in one sentence. */
	says: string;
	lines: ProofLine[];
	/** Program output worth showing as it was printed. */
	printed?: string;
}

export interface Evidence {
	mark: Mark;
	headline: string;
	/** What nothing checked, one sentence each. */
	gaps: string[];
	/** Why the proofs may no longer hold: the work changed after they were gathered. Null: they hold, or nobody can tell. */
	stale: string | null;
	proofs: Proof[];
	/** The commit the checks saw and when they finished; empty and null before the first check. */
	head: string;
	at: number | null;
}

/** The language servers' verdict on the change (`WorkCheck` in agents.store.ts), as much of it as is read here. */
export interface CheckLike {
	state: 'checking' | 'done';
	problems: { path: string; line: number; message: string }[];
	known: number;
	impact: { symbol: string; uses: unknown[] }[];
	servers: string[];
	files: number;
	users: number;
	finished: boolean;
}

export interface EvidenceInput {
	pipeline: Pipeline;
	/** Null: no server looked. Left out: the language servers are not part of what is asked (`shipNote`). */
	check?: CheckLike | null;
	/** The language servers' check of a change is on (Settings > Language servers). */
	checksOn?: boolean;
	/** The task's worktree as it is now; null when nobody knows (it is gone, or was not looked at). */
	tree?: { head: string; changes: number } | null;
}

function n(count: number, word: string, many = `${word}s`): string {
	return `${count} ${count === 1 ? word : many}`;
}

/** A file that is a test, by where it is or what it is called. */
export function isTestFile(path: string): boolean {
	return /(^|\/)(tests?|__tests__|specs?|e2e)\//i.test(path) || /[._-](test|spec)\.[a-z]+$/i.test(path) || /(^|\/)test_[^/]+\.py$/.test(path) || /Tests?\.(cs|php|java|kt|swift)$/.test(path);
}

/** Files the language servers Studio knows could have looked at (`lsp/servers.rs`). */
function isCode(path: string): boolean {
	return /\.(tsx?|jsx?|mjs|cjs|php|cs|rs|py|go)$/i.test(path);
}

function seconds(ms: number): string {
	return ms < 950 ? '' : ms < 60_000 ? ` in ${Math.round(ms / 100) / 10} s` : ` in ${Math.round(ms / 6000) / 10} min`;
}

function tests(p: Pipeline, gaps: string[]): Proof {
	const t = p.tests;
	const title = 'Tests';
	if (!t) {
		const running = p.steps.test.state === 'run';
		return { id: 'tests', mark: running ? 'run' : 'none', title, says: running ? 'Running now.' : 'Not run yet.', lines: [] };
	}
	if (t.none) {
		gaps.push('No tests ran: Studio found no test target in this project.');
		return { id: 'tests', mark: 'none', title, says: 'No tests ran: this project has none Studio could find.', lines: [] };
	}
	const lines: ProofLine[] = t.commands.map((c) => ({ text: `$ ${c}` }));
	if (!t.ok) {
		return { id: 'tests', mark: 'bad', title, says: t.summary, lines: [...t.failures.map((f) => ({ text: `Failed: ${f}` })), ...lines], printed: t.printed || t.output || undefined };
	}
	const files = p.checked?.files ?? [];
	const own = files.filter((f) => f.status !== 'deleted' && isTestFile(f.path));
	if (own.length) {
		lines.push({ text: `The change brings ${n(own.length, 'test file')} of its own: ${own.slice(0, 4).map((f) => f.path).join(', ')}${own.length > 4 ? ` and ${own.length - 4} more` : ''}` });
	}
	// Not a gap (the tests did run), but worth a word where it is read: nothing new tests what a bug fix or a feature brought.
	const old = !own.length && files.some((f) => isCode(f.path)) && (p.kind === 'bug' || p.kind === 'feature');
	return { id: 'tests', mark: 'ok', title, says: `${t.summary}${seconds(t.millis ?? 0)}${old ? ' · all written before this change' : ''}`, lines, printed: t.printed || undefined };
}

function review(p: Pipeline, gaps: string[]): Proof {
	const title = 'Review';
	const state = p.steps.review.state;
	if (state === 'skip') {
		gaps.push(`Nobody reviewed it: a ${kindOf(p.kind).name.toLowerCase()} skips the review.`);
		return { id: 'review', mark: 'none', title, says: `Not reviewed: a ${kindOf(p.kind).name.toLowerCase()} skips the review.`, lines: [] };
	}
	if (state !== 'done' && state !== 'warn') {
		return { id: 'review', mark: state === 'run' ? 'run' : 'none', title, says: state === 'run' ? 'Reading the change now.' : 'Not reviewed yet.', lines: [] };
	}
	if (p.checked?.truncated) {
		gaps.push('The review read only part of the change: the diff was too large to send whole.');
	}
	const count = (severity: string): number => p.findings.filter((f) => f.severity === severity).length;
	const [bugs, risks, nits] = [count('bug'), count('risk'), count('nit')];
	const lines: ProofLine[] = p.findings.map((f) => ({ text: `${f.severity} · ${f.title}`, detail: f.detail || undefined, place: f.file ? { path: f.file, line: f.line ?? 1 } : undefined }));
	if (bugs) {
		return { id: 'review', mark: 'bad', title, says: `${n(bugs, 'bug')} found${risks ? `, and ${n(risks, 'risk')}` : ''}.`, lines };
	}
	if (risks) {
		return { id: 'review', mark: 'warn', title, says: `No bugs. ${n(risks, 'risk')} left for you to judge${nits ? `, and ${n(nits, 'nit')}` : ''}.`, lines };
	}
	return { id: 'review', mark: 'ok', title, says: nits ? `No bugs or risks. ${n(nits, 'nit')}.` : 'Read by Claude: no findings.', lines };
}

function types(input: EvidenceInput, gaps: string[]): Proof | null {
	const title = 'Language servers';
	const c = input.check;
	if (c === undefined) {
		return null;
	}
	const code = (input.pipeline.checked?.files ?? []).filter((f) => f.status !== 'deleted' && isCode(f.path)).length;
	if (!input.checksOn) {
		if (code) {
			gaps.push('No compiler looked at it: the language servers’ check is off in Settings.');
		}
		return { id: 'types', mark: 'none', title, says: 'Off in Settings > Language servers.', lines: [] };
	}
	if (!c) {
		if (code) {
			gaps.push(`No compiler looked at it: no language server checked the ${n(code, 'code file')} it changed.`);
		}
		return { id: 'types', mark: 'none', title, says: code ? 'No language server looked at the files it changed.' : 'Nothing in the change for a language server to check.', lines: [] };
	}
	if (c.state === 'checking') {
		return { id: 'types', mark: 'run', title, says: 'Checking the change now.', lines: [] };
	}
	const lines: ProofLine[] = c.problems.map((x) => ({ text: `${x.path}:${x.line}`, detail: x.message, place: { path: x.path, line: x.line } }));
	for (const i of c.impact) {
		lines.push({ text: `It changed ${i.symbol}, used in ${n(i.uses.length, 'place')} it did not touch` });
	}
	if (c.known) {
		lines.push({ text: `${n(c.known, 'error')} in these files ${c.known === 1 ? 'was' : 'were'} there before the change and still ${c.known === 1 ? 'is' : 'are'}` });
	}
	if (!c.finished) {
		gaps.push('A language server was still working when its time ran out: there may be errors it had not reported.');
	}
	const who = c.servers.join(', ');
	if (c.problems.length) {
		return { id: 'types', mark: 'bad', title, says: `${n(c.problems.length, 'new error')} the change brought · ${who}`, lines };
	}
	const where = `${n(c.files, 'changed file')}${c.users ? ` and ${n(c.users, 'file')} that use${c.users === 1 ? 's' : ''} them` : ''}`;
	return { id: 'types', mark: c.finished ? 'ok' : 'warn', title, says: `No new errors in ${where} · ${who}`, lines };
}

/** The rounds of the loop, one per count of fixes (a round run again after a stop replaces the earlier one). */
function lastRounds(rounds: Round[]): Round[] {
	const by = new Map<number, Round>();
	for (const r of rounds) {
		by.set(r.fixes, r);
	}
	return [...by.values()].sort((a, b) => a.fixes - b.fixes);
}

function loop(p: Pipeline): Proof | null {
	const rounds = lastRounds(p.rounds ?? []);
	if (!rounds.length) {
		return null;
	}
	const clean = (r: Round): boolean => r.ok && r.holding === 0;
	const found = (r: Round): string => [r.ok ? '' : r.tests, r.holding ? n(r.holding, 'review finding') : ''].filter(Boolean).join(' and ') || 'nothing to fix';
	const last = rounds[rounds.length - 1];
	const lines: ProofLine[] = rounds.map((r) => ({ text: `${r.fixes ? `After fix ${r.fixes}` : 'First look'}: ${clean(r) ? `clean (${r.tests})` : found(r)}` }));
	const title = 'The loop';
	if (!clean(last)) {
		return { id: 'loop', mark: 'bad', title, says: last.fixes ? `Still not clean after ${n(last.fixes, 'fix', 'fixes')}: ${found(last)}.` : `The first look found ${found(last)}.`, lines };
	}
	return { id: 'loop', mark: 'ok', title, says: last.fixes ? `Clean after ${n(last.fixes, 'fix', 'fixes')}: each one was reviewed and tested again.` : 'Clean at the first look: nothing needed fixing.', lines: rounds.length > 1 ? lines : [] };
}

function change(p: Pipeline): Proof | null {
	const c = p.checked;
	if (!c) {
		return null;
	}
	const shown = 12;
	const lines: ProofLine[] = c.files.slice(0, shown).map((f) => ({ text: `${f.status} · ${f.path}`, place: f.status === 'deleted' ? undefined : { path: f.path, line: 1 } }));
	if (c.files.length > shown) {
		lines.push({ text: `and ${c.files.length - shown} more` });
	}
	if (p.pushed) {
		lines.push({ text: p.pushed });
	}
	if (!c.files.length) {
		return { id: 'change', mark: 'warn', title: 'The change', says: 'Nothing changed since the task started.', lines };
	}
	return { id: 'change', mark: 'ok', title: 'The change', says: `${n(c.files.length, 'file')} changed${c.commits ? ` in ${n(c.commits, 'commit')}` : ''} since the task started.`, lines };
}

/** Whether the worktree moved after the checks ran. Only asked while the task waits at Ship: before that it is meant to move. */
function staleness(input: EvidenceInput): string | null {
	const p = input.pipeline;
	const tree = input.tree;
	if (!tree || !p.checked || p.step !== 'ship' || !p.waiting) {
		return null;
	}
	if (tree.changes > 0) {
		return `Its worktree has ${n(tree.changes, 'uncommitted change')} the checks never saw.`;
	}
	if (p.checked.head && tree.head && tree.head !== p.checked.head) {
		return `Its branch has moved since the checks ran: they saw ${p.checked.head.slice(0, 7)}, it is at ${tree.head.slice(0, 7)}.`;
	}
	return null;
}

/**
 * What the pipeline says when it reaches Ship, for lists, cards and toasts: the checks that are the
 * pipeline's own (tests, review). The language servers' check may still be going then; the page has it.
 */
export function shipNote(p: Pipeline): string {
	const e = evidenceOf({ pipeline: p });
	const after = p.fixes ? ` after ${n(p.fixes, 'fix', 'fixes')}` : '';
	const notes = p.findings.length ? ` The review left ${n(p.findings.length, 'note')} to look at.` : '';
	const passed = e.gaps.length ? `The checks that ran pass${after}, but ${n(e.gaps.length, 'thing')} nothing checked (see Ship).` : `Every check passes${after}.`;
	return `${passed} Merge it or open a pull request.${notes}`;
}

/** Whether there is anything to show yet: a check has run, or one is running. */
export function hasEvidence(p: Pipeline): boolean {
	return !!p.rounds?.length || !!p.checked || !!p.tests;
}

export function evidenceOf(input: EvidenceInput): Evidence {
	const p = input.pipeline;
	const gaps: string[] = [];
	const proofs = [tests(p, gaps), review(p, gaps), types(input, gaps), loop(p), change(p)].filter((x): x is Proof => !!x);
	const stale = staleness(input);
	const has = (m: Mark): boolean => proofs.some((x) => x.mark === m);
	const bad = proofs.filter((x) => x.mark === 'bad' && x.id !== 'loop');
	let mark: Mark;
	let headline: string;
	if (bad.length || has('bad')) {
		mark = 'bad';
		headline = bad.length ? `Not ready: ${bad.map((x) => x.title.toLowerCase()).join(' and ')} found problems` : 'Not ready: the checks are not clean';
	} else if (has('run')) {
		mark = 'run';
		headline = 'Still checking';
	} else if (stale) {
		mark = 'warn';
		headline = 'Changed since it was checked';
	} else if (gaps.length || has('warn')) {
		mark = 'warn';
		headline = gaps.length ? `Passed what was checked · ${n(gaps.length, 'thing')} nothing checked` : 'Passed, with something left for you to judge';
	} else {
		mark = 'ok';
		headline = 'Every check passed';
	}
	return { mark, headline, gaps, stale, proofs, head: p.checked?.head ?? '', at: p.checked?.at ?? null };
}

const SIGNS: Record<Mark, string> = { ok: '✓', warn: '!', bad: '✗', none: '–', run: '…' };

/** The evidence as plain text, for a pull request's description or a commit: the verdict, each proof in a line, the gaps. */
export function evidenceText(e: Evidence): string {
	const out = [`${e.headline}${e.head ? ` (checked at ${e.head.slice(0, 7)})` : ''}`, ''];
	for (const p of e.proofs) {
		out.push(`${SIGNS[p.mark]} ${p.title}: ${p.says}`);
	}
	if (e.gaps.length) {
		out.push('', 'Not checked:', ...e.gaps.map((g) => `- ${g}`));
	}
	return out.join('\n');
}
