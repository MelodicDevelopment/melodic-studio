/**
 * Runs a task's pipeline (`shared/pipeline.ts`): Plan → Code → Review → Test → Fix → Ship.
 *
 * Claude's steps (plan, code, fix) are turns of the task's own agent session, so the transcript holds the
 * whole story and every turn can be followed in the session pane. The others are Studio's: after Code and
 * after each Fix it commits what changed in the agent's worktree, as the user, and pushes the branch
 * (`pipeline.rs`); Review is a one-shot read-only Claude question over the worktree's diff since the task
 * started; Test runs the project's own test targets in the worktree, on this machine. When the review has
 * nothing that blocks and every test passes, it waits for the user to ship. After `MAX_FIXES` fixes that
 * did not get there, it stops and asks. Nothing is merged into another branch by any of this.
 *
 * Every step is a plain awaitable method, so a script can drive it the way the buttons do.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { ToastService } from '@melodicdev/components/toast';
import { AgentsStore, nameOf, type AgentSession } from './agents.store';
import { AiService, type Ask } from './ai.service';
import { BackendService, asAppError, type RunTarget } from './backend.service';
import { RepoStore } from './repo.store';
import { PLAN_TOOLS, REVIEW_TOOLS, parseReview, pipelineCodePrompt, pipelineFixPrompt, pipelinePlanPrompt, pipelineReviewNote, reviewPrompt } from './ai-prompts';
import { afterChecks, blocking, worthFixing, combineTests, commitMessage, kindOf, modelFor, newPipeline, withStep, type ClaudeStep, type Pipeline, type StepName, type WaitReason, type WorkKind } from '../shared/pipeline';
import type { Attachment } from './agent-images';
import { samePath } from './agent-paths';

export interface NewPipelineTask {
	task: string;
	kind: WorkKind;
	branch: string;
	models?: Partial<Record<ClaudeStep, string>>;
	images?: Attachment[];
}

/** At most this many test targets run per round (one per project, usually). */
const MAX_TEST_TARGETS = 4;

@Injectable()
export class PipelineStore {
	private _hooked = false;
	/** Studio's own steps in progress, by session: the review question or the test run, so Stop can end it. */
	private readonly _asks = new Map<string, Ask>();
	private readonly _testing = new Set<string>();
	/**
	 * How many times Stop or Discard was pressed for a session while no turn of Claude's was going. A step of
	 * Studio's own (commit and push, the review, the tests) notes the number when it starts and gives up at
	 * its next pause when it has risen: a push can take seconds, and the task must not run on after it said it stopped.
	 */
	private readonly _halts = new Map<string, number>();
	/** Tasks being given up: what their stopping says is not news to the user who is throwing them away. */
	private readonly _discarding = new Set<string>();

	private get agents(): AgentsStore {
		return Injector.get(AgentsStore);
	}
	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get toast(): ToastService {
		return Injector.get(ToastService);
	}

	/** Start following the agents' turns, once. Called by anything that shows agents. */
	init(): void {
		if (this._hooked) {
			return;
		}
		this._hooked = true;
		// Keyed, so a second copy of this store (a reloaded module) takes over instead of acting twice.
		this.agents.turnEnded.set('pipeline', (id, ok, stopped) => void this.turnEnded(id, ok, stopped));
		this.agents.landed.set('pipeline', (id) => void this.cleanUp(id, 'merged'));
	}

	private session(id: string): AgentSession | null {
		return this.agents.get(id);
	}

	private patch(id: string, change: (p: Pipeline, s: AgentSession) => Pipeline): void {
		this.agents.patchPipeline(id, change);
	}

	/** The pipeline waits on the user at its step, with this note; the step shows as "you". */
	private wait(id: string, note: string, step: StepName, reason: WaitReason = 'halted'): void {
		this.patch(id, (p) => withStep({ ...p, step, waiting: true, note, reason }, step, { state: 'you' }));
		const s = this.session(id);
		if (s && !this._discarding.has(id) && !this.onScreen(s)) {
			const repo = Injector.get(RepoStore).app()?.repos.find((r) => r.id === s.repoId);
			this.toast.show({ variant: 'info', title: `${nameOf(s)} needs you${repo && repo.id !== Injector.get(RepoStore).repo()?.id ? ` · ${repo.name}` : ''}`, message: note, duration: 9000 });
		}
	}

	private halts(id: string): number {
		return this._halts.get(id) ?? 0;
	}

	private halt(id: string): void {
		this._halts.set(id, this.halts(id) + 1);
	}

	private onScreen(s: AgentSession): boolean {
		const repos = Injector.get(RepoStore);
		return document.visibilityState === 'visible' && repos.repo()?.id === s.repoId && repos.tab() === 'agents' && this.agents.selectedId() === s.id;
	}

	// ---- starting ---------------------------------------------------------------

	/** A new task: a worktree on `branch`, then its first step (the plan, or the code for a quick fix). */
	async start(input: NewPipelineTask): Promise<boolean> {
		this.init();
		const pipeline = newPipeline(input.kind, input.models ?? {});
		const started = await this.agents.start({ task: input.task, branch: input.branch, mode: 'acceptEdits', attempts: 1, images: input.images, pipeline });
		const id = this.agents.selectedId();
		if (!started || !id) {
			return false;
		}
		await this.runStep(id, input.images);
		return true;
	}

	/** Run the step the pipeline is at, from the start. */
	private async runStep(id: string, images: Attachment[] = []): Promise<void> {
		const s = this.session(id);
		const p = s?.pipeline;
		if (!s || !p || p.step === 'done' || p.step === 'ship') {
			return;
		}
		switch (p.step) {
			case 'plan':
				return this.plan(id, images);
			case 'code':
				return kindOf(p.kind).skips.includes('plan') ? this.code(id, '', images) : this.code(id, '');
			case 'review':
				return this.review(id);
			case 'test':
				return this.test(id);
			case 'fix':
				return this.fix(id);
		}
	}

	/** A Claude turn for one of its steps. `mark` is the session's cost before it, to tell this step's share. */
	private async turn(id: string, step: ClaudeStep, prompt: string, shown: string, extra: { mode?: 'acceptEdits' | 'default'; tools?: string[]; builtin?: string[]; images?: Attachment[] } = {}): Promise<void> {
		const s = this.session(id);
		if (!s?.pipeline) {
			return;
		}
		this.patch(id, (p, x) => withStep({ ...p, step, waiting: false, note: null, reason: null, mark: x.cost }, step, { state: 'run', summary: step === 'plan' ? 'Reading the code to write a plan.' : step === 'code' ? 'Writing the code in its worktree.' : `Fixing what round ${p.fixes} found.`, lines: [] }));
		await this.agents.send(id, prompt, { shown, raw: true, images: extra.images, turn: { mode: extra.mode ?? 'acceptEdits', tools: extra.tools, builtin: extra.builtin, model: modelFor(s.pipeline, step) } });
	}

	private plan(id: string, images: Attachment[] = []): Promise<void> {
		const s = this.session(id)!;
		const task = s.task || s.title;
		return this.turn(id, 'plan', pipelinePlanPrompt(task, s.pipeline!.kind), task, { mode: 'default', tools: PLAN_TOOLS, builtin: PLAN_TOOLS, images });
	}

	/** Ask for changes to the plan before approving it: another planning turn. */
	async revisePlan(id: string, feedback: string): Promise<void> {
		const text = feedback.trim();
		if (!text) {
			return;
		}
		await this.turn(id, 'plan', `[pipeline-plan]\nChange the plan as asked below, then give the whole plan again, ending with the brief. You can still only read and search the code.\n\n${text}`, text, { mode: 'default', tools: PLAN_TOOLS, builtin: PLAN_TOOLS });
	}

	/** The user approves the plan (with their answer to its question, if it asked one): coding starts. */
	async approve(id: string, answer = ''): Promise<void> {
		this.patch(id, (p) => withStep(p, 'plan', { state: 'done', summary: answer ? `Approved by you, with: ${answer}` : 'Approved by you.' }));
		await this.code(id, answer);
	}

	private code(id: string, answer: string, images: Attachment[] = []): Promise<void> {
		const s = this.session(id)!;
		const quick = kindOf(s.pipeline!.kind).skips.includes('plan');
		const prompt = pipelineCodePrompt(answer, quick && !s.sessionId ? { task: s.task || s.title, kind: s.pipeline!.kind } : null);
		return this.turn(id, 'code', prompt, quick && !s.sessionId ? s.task || s.title : answer ? `Plan approved: ${answer}` : 'Plan approved. Build it.', { images });
	}

	private fix(id: string): Promise<void> {
		const p = this.session(id)!.pipeline!;
		// Bugs and risks go to any fix that runs; only bugs (and failing tests) start one after the first.
		const findings = worthFixing(p.findings);
		const tests = p.tests && !p.tests.ok ? p.tests : null;
		const what = [findings.length ? `${findings.length} review ${findings.length === 1 ? 'finding' : 'findings'}` : '', tests ? tests.summary : ''].filter(Boolean).join(' and ');
		return this.turn(id, 'fix', pipelineFixPrompt({ fix: p.fixes, of: p.allowedFixes, findings, tests }), `Fix ${p.fixes} of ${p.allowedFixes}: ${what || 'what the checks found'}`);
	}

	// ---- a Claude turn ended ----------------------------------------------------------

	private async turnEnded(id: string, ok: boolean, stopped: boolean): Promise<void> {
		const s = this.session(id);
		const p = s?.pipeline;
		if (!s || !p) {
			return;
		}
		// What this turn cost, on the step it was for.
		const step: StepName = p.step === 'done' ? 'ship' : p.step;
		const share = Math.max(0, s.cost - (p.mark ?? s.cost));
		this.patch(id, (x) => withStep({ ...x, mark: undefined }, step, { cost: x.steps[step].cost + share }));
		if (stopped) {
			this.wait(id, 'Stopped by you. Its branch keeps everything committed so far.', step);
			return;
		}
		if (!ok) {
			const said = [...s.items].reverse().find((i) => i.kind === 'error')?.text ?? 'Claude Code failed.';
			this.wait(id, `This step failed: ${said.slice(0, 200)}`, step);
			return;
		}
		if (step === 'plan') {
			const plan = this.lastReply(s);
			const brief = s.brief;
			const needs = brief?.needs && !/^approve\b/i.test(brief.needs) ? brief.needs : null;
			this.patch(id, (x) => withStep({ ...x, plan }, 'plan', { summary: brief?.did ?? 'A plan is ready.', lines: [] }));
			if (kindOf(p.kind).planGate || needs) {
				this.wait(id, needs ?? 'Approve the plan to start coding.', 'plan', 'approve');
			} else {
				await this.approve(id);
			}
			return;
		}
		// Code, a fix, or a message the user sent along the way: the work is committed and checked again.
		await this.afterWork(id, step === 'fix' ? 'fix' : 'code');
	}

	/** The text of the last reply, without its brief. */
	private lastReply(s: AgentSession): string {
		const out: string[] = [];
		for (let i = s.items.length - 1; i >= 0 && s.items[i].kind !== 'user'; i--) {
			const item = s.items[i];
			if (item.kind === 'text' && item.text.trim()) {
				out.unshift(item.text.trim());
			}
		}
		return out.join('\n\n');
	}

	/** After Code or a Fix: the step is done; the review commits and pushes the work, then checks it. */
	private async afterWork(id: string, step: 'code' | 'fix'): Promise<void> {
		const brief = this.session(id)?.brief;
		this.patch(id, (x) => withStep({ ...x, step, waiting: false, note: null, reason: null }, step, { state: 'done', summary: brief?.did ?? x.steps[step].summary }));
		await this.review(id, step);
	}

	/**
	 * Commit everything in the worktree as the user and push the branch. Runs before every review, so work
	 * a stopped step left behind is committed too and never missed by a merge. False when committing failed.
	 */
	private async commit(id: string, step: StepName): Promise<boolean> {
		const s = this.session(id);
		const p = s?.pipeline;
		if (!s || !p) {
			return false;
		}
		const brief = s.brief;
		const kind = step === 'fix' ? 'fix' : 'code';
		try {
			const done = await this.backend.pipelineCommit(s.repoId, s.cwd, commitMessage(kind, brief?.title ?? nameOf(s), brief?.did ?? '', p.fixes));
			if (!done.committed) {
				return true;
			}
			const pushed = done.pushed ? `Committed ${done.head.slice(0, 7)} and pushed ${s.branch ?? 'its branch'}.` : `Committed ${done.head.slice(0, 7)}; not pushed: ${done.pushError ?? 'no remote'}.`;
			this.patch(id, (x) => withStep({ ...x, pushed }, step, { lines: [...x.steps[step].lines.filter((l) => !l.startsWith('Committed ')), pushed] }));
			return true;
		} catch (e) {
			this.wait(id, `Committing the work failed: ${asAppError(e).message.slice(0, 200)}`, step);
			return false;
		}
	}

	// ---- Studio's steps -------------------------------------------------------------

	/** Review: a read-only question to Claude over everything the worktree has since the task started. */
	async review(id: string, after: StepName | null = null): Promise<void> {
		const before = this.session(id)?.pipeline;
		const halts = this.halts(id);
		if (!before || !(await this.commit(id, after ?? (before.fixes ? 'fix' : 'code'))) || halts !== this.halts(id)) {
			return; // committing failed, or Stop was pressed while it went
		}
		const s = this.session(id);
		const p = s?.pipeline;
		if (!s || !p) {
			return;
		}
		if (p.steps.review.state === 'skip') {
			this.patch(id, (x) => ({ ...x, findings: [] }));
			return this.test(id);
		}
		this.patch(id, (x) => withStep({ ...x, step: 'review', waiting: false, note: null, reason: null }, 'review', { state: 'run', summary: x.fixes ? `Reviewing fix ${x.fixes}.` : 'Reviewing the change.', lines: [] }));
		try {
			const { text, ...range } = await this.backend.pipelineReviewDiff(s.repoId, s.cwd, s.base);
			if (halts !== this.halts(id)) {
				return;
			}
			if (!range.files.length || !text.trim()) {
				this.patch(id, (x) => withStep({ ...x, findings: [] }, 'review', { state: 'done', summary: 'Nothing changed since the task started, so there was nothing to review.' }));
				return this.test(id);
			}
			const note = pipelineReviewNote(s.task || s.title, p.kind);
			const ask = Injector.get(AiService).ask({
				prompt: reviewPrompt({ scope: 'work', agent: true, branch: s.branch ?? '', against: range.against, commits: range.commits, files: range.files, diff: text, truncated: range.truncated }) + note,
				tools: REVIEW_TOOLS,
				model: modelFor(p, 'review'),
				where: { repoId: s.repoId, cwd: s.cwd },
				onCost: (usd) => this.patch(id, (x) => withStep(x, 'review', { cost: x.steps.review.cost + usd })),
			});
			this._asks.set(id, ask);
			const answer = await ask.result.finally(() => this._asks.delete(id));
			const review = parseReview(answer, range.files.map((f) => f.path));
			if (!review) {
				this.wait(id, 'The review answered in a form Studio could not read. Carry on to review again.', 'review');
				return;
			}
			const holding = blocking(review.findings, p.fixes);
			this.patch(id, (x) =>
				withStep({ ...x, findings: review.findings }, 'review', {
					state: holding.length ? 'warn' : 'done',
					summary: holding.length ? `${holding.length} ${holding.length === 1 ? 'finding' : 'findings'} for Fix. ${review.summary}` : review.findings.length ? `${review.findings.length} to look at when you ship; none hold it up. ${review.summary}` : review.summary || 'No findings.',
					lines: review.findings.map((f) => `${f.file}${f.line !== null ? `:${f.line}` : ''} · ${f.severity} · ${f.title}`),
				})
			);
		} catch (e) {
			if (halts !== this.halts(id) || this.session(id)?.pipeline?.waiting) {
				return; // stopped meanwhile
			}
			this.wait(id, `The review did not finish: ${asAppError(e).message.slice(0, 200)}`, 'review');
			return;
		}
		await this.test(id);
	}

	/** Test: the project's test targets, run in the worktree on this machine. Free. */
	async test(id: string): Promise<void> {
		const s = this.session(id);
		if (!s?.pipeline) {
			return;
		}
		this.patch(id, (x) => withStep({ ...x, step: 'test', waiting: false, note: null, reason: null }, 'test', { state: 'run', summary: 'Running the tests on this machine.', lines: [] }));
		const halts = this.halts(id);
		let targets: RunTarget[];
		try {
			targets = (await this.backend.pipelineTests(s.repoId, s.cwd)).slice(0, MAX_TEST_TARGETS);
		} catch (e) {
			if (halts === this.halts(id)) {
				this.wait(id, `The tests could not be found: ${asAppError(e).message.slice(0, 200)}`, 'test');
			}
			return;
		}
		if (halts !== this.halts(id)) {
			return; // Stop has said so already
		}
		const runs: { ok: boolean; command: string; output: string; code: number | null }[] = [];
		this._testing.add(id);
		try {
			for (const t of targets) {
				this.patch(id, (x) => withStep(x, 'test', { summary: `Running ${t.argv.join(' ')}${t.cwd ? ` in ${t.cwd}` : ''}.` }));
				const run = await this.backend.pipelineTestRun(s.repoId, s.cwd, `pipeline:${id}`, t.id);
				if (run.stopped || !this._testing.has(id)) {
					return; // Stop has said so already
				}
				runs.push({ ok: run.ok, command: t.cwd ? `${run.command} (in ${t.cwd})` : run.command, output: run.output, code: run.code });
			}
		} catch (e) {
			this.wait(id, `The tests did not run: ${asAppError(e).message.slice(0, 200)}`, 'test');
			return;
		} finally {
			this._testing.delete(id);
		}
		const tests = combineTests(runs);
		this.patch(id, (x) => withStep({ ...x, tests }, 'test', { state: tests.ok ? 'done' : 'warn', summary: tests.summary, lines: tests.failures }));
		await this.decide(id);
	}

	/** After a round's review and tests: ship, fix again, or ask. */
	private async decide(id: string): Promise<void> {
		const p = this.session(id)?.pipeline;
		if (!p) {
			return;
		}
		const next = afterChecks(p);
		if (next === 'ship') {
			this.patch(id, (x) => withStep(x, 'fix', { state: x.fixes ? 'done' : x.steps.fix.state === 'skip' ? 'skip' : 'next' }));
			const notes = p.findings.length ? ` The review left ${p.findings.length} ${p.findings.length === 1 ? 'note' : 'notes'} to look at (see Review).` : '';
			this.wait(id, `Every check passes${p.fixes ? ` after ${p.fixes} ${p.fixes === 1 ? 'fix' : 'fixes'}` : ''}. Merge it or open a pull request.${notes}`, 'ship', 'ship');
			return;
		}
		if (next === 'ask') {
			const holding = blocking(p.findings, p.fixes).length;
			const left = [p.tests && !p.tests.ok ? p.tests.summary : '', holding ? `${holding} review ${holding === 1 ? 'finding' : 'findings'} left` : ''].filter(Boolean).join('; ');
			this.patch(id, (x) => withStep(x, 'fix', { summary: `Stopped after ${x.fixes} ${x.fixes === 1 ? 'fix' : 'fixes'}. ${left}.`, lines: x.tests?.failures ?? [] }));
			this.wait(id, `Stopped after ${p.fixes} ${p.fixes === 1 ? 'fix' : 'fixes'}: ${left}.`, 'fix', 'limit');
			return;
		}
		this.patch(id, (x) => ({ ...x, fixes: x.fixes + 1 }));
		await this.fix(id);
	}

	// ---- the user's buttons ----------------------------------------------------------

	/** Stop whatever step is going: Claude's turn, the review, or the tests. It then waits for the user. */
	async stop(id: string): Promise<void> {
		const s = this.session(id);
		if (!s?.pipeline) {
			return;
		}
		if (s.status === 'running') {
			await this.agents.stop(id); // the turn's end says the rest
			return;
		}
		const step = s.pipeline.step === 'done' ? 'ship' : s.pipeline.step;
		this.halt(id);
		this.wait(id, 'Stopped by you. Its branch keeps everything committed so far.', step);
		this._asks.get(id)?.cancel();
		if (this._testing.delete(id)) {
			await this.backend.pipelineTestStop(`pipeline:${id}`).catch(() => undefined);
		}
	}

	/** After a stop or a failure: run the step it stopped at again. */
	async carryOn(id: string): Promise<void> {
		const p = this.session(id)?.pipeline;
		if (!p || !p.waiting) {
			return;
		}
		if (p.reason === 'approve') {
			return this.approve(id); // waiting for approval: carrying on is approving
		}
		if (p.reason === 'limit') {
			return this.oneMoreRound(id);
		}
		if (p.reason === 'ship') {
			return;
		}
		this.patch(id, (x) => ({ ...x, waiting: false, note: null, reason: null }));
		await this.runStep(id);
	}

	/** At the fix limit: allow one more fix. */
	async oneMoreRound(id: string): Promise<void> {
		this.patch(id, (x) => ({ ...x, allowedFixes: x.allowedFixes + 1, waiting: false, note: null, reason: null }));
		await this.decide(id);
	}

	/**
	 * Remove what a task left behind: its worktree (anything uncommitted in it included), its branch, and the
	 * copy of the branch it pushed. After a merge (`merged`) or when the user gives the task up (`discarded`).
	 * The session stays, as a record of what was done.
	 */
	async cleanUp(id: string, why: 'merged' | 'discarded'): Promise<boolean> {
		const s = this.session(id);
		if (!s?.pipeline || !s.isolated || !s.branch) {
			return false;
		}
		const repos = Injector.get(RepoStore);
		try {
			if (repos.repo()?.id === s.repoId && this.agents.worktrees().some((w) => w.active && !w.isMain && samePath(w.path, s.cwd))) {
				await this.agents.view(null, 'agents'); // the app leaves the checkout before it goes
			}
			const done = await this.backend.pipelineClean(s.repoId, s.cwd, s.branch);
			const gone = [done.removedTree ? 'its worktree' : '', done.deletedBranch ? s.branch : '', ...done.deletedRemote].filter(Boolean);
			if (gone.length) {
				this.toast.success(why === 'merged' ? 'Merged and cleaned up' : 'Task discarded', `Removed ${gone.join(', ')}.`);
			}
			if (done.problems.length) {
				this.toast.warning('Not everything was cleaned up', done.problems.join(' ').slice(0, 400));
			}
			if (repos.repo()?.id === s.repoId) {
				await this.agents.loadWorktrees();
				await repos.loadBranches();
			}
			return true;
		} catch (e) {
			this.toast.error('Cleaning up failed', asAppError(e).message.slice(0, 300));
			return false;
		}
	}

	/**
	 * Give a task up: stop it, then delete its worktree and branch, here and on the remote. Nothing is merged.
	 * False when the cleanup failed, so its worktree and branch are still there (and the session should stay, to find them by).
	 */
	async discard(id: string): Promise<boolean> {
		const s = this.session(id);
		if (!s?.pipeline) {
			return true;
		}
		const own = !!s.isolated && !!s.branch;
		this._discarding.add(id);
		this.halt(id);
		try {
			if (s.status === 'running') {
				await this.agents.stop(id);
				await this.agents.idle(id, 4000);
			}
			this._asks.get(id)?.cancel();
			if (this._testing.delete(id)) {
				await this.backend.pipelineTestStop(`pipeline:${id}`).catch(() => undefined);
			}
			const cleaned = await this.cleanUp(id, 'discarded');
			if (cleaned) {
				this.agents.patchPipeline(id, (p) => withStep({ ...p, step: 'done', waiting: false, note: null, reason: null }, 'ship', { state: 'skip', summary: 'Discarded: its worktree and branch were deleted.' }));
				this.agents.markDone(id);
			}
			return cleaned || !own;
		} finally {
			this._discarding.delete(id);
		}
	}

	/** A different model for one of Claude's steps of this task, from its next run on. */
	setModel(id: string, step: ClaudeStep, model: string): void {
		this.agents.patchPipeline(id, (p) => ({ ...p, models: { ...p.models, [step]: model } }), false);
	}

	/** Something the user typed in the session's box. While the plan waits it changes the plan; otherwise it is work, checked like any other. */
	async message(id: string, text: string, images: Attachment[] = []): Promise<void> {
		const p = this.session(id)?.pipeline;
		if (p?.step === 'plan') {
			return this.revisePlan(id, text);
		}
		const step: ClaudeStep = p && p.fixes ? 'fix' : 'code';
		await this.turn(id, step, text, text, { images });
	}
}

/** Made at load, like the other stores with work of their own, so it hears turns end from the start. */
export const pipelines = (): PipelineStore => Injector.get(PipelineStore);
