/**
 * The AI features around changes and diffs: a commit message from the checked files,
 * an explanation of a diff or a commit, a review of what a push would send, and a
 * proposed resolution for a conflicted file. Each is one question to Claude Code
 * (`AiService.ask`); the prompts and the parsing of their answers live in ai-prompts.ts.
 *
 * Every action has the same shape: collect a bounded diff from the backend, ask,
 * parse, and leave the result in a signal the UI reads. A run can be stopped at any
 * point; a run that was stopped or replaced never writes its result.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed, effect, untracked } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { AiService, type Ask } from './ai.service';
import { BackendService, asAppError, type FileChange, type PushDiff } from './backend.service';
import { RepoStore } from './repo.store';
import { parseDiff, type DiffNote, type ParsedDiff } from '../shared/diff';
import { fileName } from '../shared/format';
import {
	MODELS,
	RESOLVE_MAX_CHARS,
	REVIEW_TOOLS,
	applyResolutions,
	commitMessagePrompt,
	conflictListing,
	explainPrompt,
	parseCommitMessage,
	parseConflicts,
	parseReview,
	resolvePrompt,
	reviewPrompt,
	type CommitMessage,
	type ExplainTarget,
	type Finding,
} from './ai-prompts';

export type RunState = 'collecting' | 'running' | 'done' | 'stopped' | 'error';

export interface ExplainState {
	target: ExplainTarget;
	/** "queue.ts" or "Commit a1b2c3d". */
	title: string;
	/** The full path, or the commit's summary. */
	detail: string;
	state: RunState;
	/** Markdown, growing while Claude writes. */
	text: string;
	error: string;
}

export interface ReviewState {
	state: RunState;
	/** What was reviewed; null until the diff has been read. */
	range: Omit<PushDiff, 'text'> | null;
	summary: string;
	findings: Finding[];
	error: string;
	/** The answer as Claude gave it, kept when it could not be read as findings. */
	raw: string;
	/** What Claude last said while working (it may look at files before answering). */
	progress: string;
}

/** The file of a reviewed range that the main pane is showing, with its findings in place. */
export interface ReviewView {
	path: string;
	/** The finding that was clicked: its line is scrolled into view. */
	line: number | null;
	/** Null while loading. */
	diff: ParsedDiff | null;
}

export interface ProposalState {
	path: string;
	/** The checkout the file was read from. */
	root: string;
	state: 'reading' | 'running' | 'ready' | 'applying';
	conflicts: number;
	/** The conflict-marked text the proposal was made from. */
	original: string;
	/** The whole file as proposed. */
	text: string;
	summary: string;
	/** From the file as it is to the proposal; null until it is ready. */
	diff: ParsedDiff | null;
}

const MISSING = 'Claude Code (the `claude` command) was not found on this computer. Install it and sign in to use the AI features.';

function running(state: RunState | undefined): boolean {
	return state === 'collecting' || state === 'running';
}

@Injectable()
export class AiFeaturesStore {
	/** Claude Code's version; null when the CLI is missing, undefined until checked. */
	readonly cli = signal<string | null | undefined>(undefined);
	/** Why the entry points are disabled, or '' when they are not. */
	readonly unavailable = computed<string>(() => (this.cli() === null ? MISSING : ''));

	// ---- commit message ----
	readonly writing = signal(false);
	/** A message waiting for the user to take or leave, because they had typed their own. */
	readonly suggestion = signal<CommitMessage | null>(null);

	// ---- side panel: an explanation and/or a review ----
	readonly explanation = signal<ExplainState | null>(null);
	readonly reviewed = signal<ReviewState | null>(null);
	readonly panelTab = signal<'explain' | 'review'>('explain');
	readonly reviewView = signal<ReviewView | null>(null);

	// ---- conflict resolution ----
	readonly proposal = signal<ProposalState | null>(null);

	/** The side panel belongs to the Changes and History tabs. */
	readonly panelOpen = computed<boolean>(() => {
		const tab = this.repos.tab();
		return (tab === 'changes' || tab === 'history') && !!(this.explanation() || this.reviewed());
	});

	/** Set when a push would send something; `count` is 0 when the number of commits is not known yet. */
	readonly unpushed = computed<{ count: number } | null>(() => {
		const st = this.repos.status();
		if (!st || !st.hasCommits || st.detached) {
			return null;
		}
		if (st.upstream) {
			return st.ahead > 0 ? { count: st.ahead } : null;
		}
		// Never pushed: History knows which commits are on no remote, once it has been opened.
		const loaded = this.repos.commits().filter((c) => c.unpushed).length;
		return loaded || st.undo ? { count: loaded } : null;
	});

	/** Findings of the file in the main pane, as notes for the diff view. */
	readonly reviewNotes = computed<DiffNote[]>(() => {
		const view = this.reviewView();
		const findings = this.reviewed()?.findings ?? [];
		return view ? findings.filter((f) => f.file === view.path).map((f) => ({ line: f.line, tone: f.severity, label: f.severity, title: f.title, detail: f.detail })) : [];
	});

	private _started = false;
	private _commitRun = 0;
	private _commitAsk: Ask | null = null;
	private _explainRun = 0;
	private _explainAsk: Ask | null = null;
	private _reviewRun = 0;
	private _reviewAsk: Ask | null = null;
	private _proposalRun = 0;
	private _proposalAsk: Ask | null = null;
	private readonly _rangeDiffs = new Map<string, ParsedDiff>();

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}
	private get ai(): AiService {
		return Injector.get(AiService);
	}
	private get toast(): ToastService {
		return Injector.get(ToastService);
	}

	/** The checkout everything here is about: results never cross into another one. */
	private scope(): string {
		const repo = this.repos.repo();
		return repo ? `${repo.id}\n${repo.worktree ?? ''}` : '';
	}

	// ---- lifecycle ----------------------------------------------------------

	/** Called by whatever offers these features (see components/ai/ai-entry.ts). Safe to call again. */
	init(): void {
		if (this._started) {
			return;
		}
		this._started = true;
		// Deferred so the effects below belong to no component: one created while a component
		// is being set up would be destroyed with it.
		setTimeout(() => this.watch(), 0);
	}

	private watch(): void {
		void this.checkCli();
		// Someone who was told the CLI is missing will install it and come back.
		window.addEventListener('focus', () => {
			if (this.cli() === null) {
				void this.checkCli();
			}
		});

		// Another repository or worktree: nothing here applies to it.
		let scope = this.scope();
		effect(() => {
			const next = this.scope();
			if (next !== scope) {
				scope = next;
				untracked(() => this.reset());
			}
		});
		// Picking something else to look at takes the main pane back from a review finding.
		let seen = '';
		effect(() => {
			const now = [this.repos.tab(), this.repos.selectedPath(), this.repos.selectedHash(), this.repos.selectedCommitPath()].join('\n');
			if (seen && now !== seen && untracked(() => this.reviewView())) {
				untracked(() => this.reviewView.set(null));
			}
			seen = now;
		});
		// A proposal is for a conflicted file; once the file is settled some other way it is moot.
		effect(() => {
			const files = this.repos.status()?.files;
			const p = untracked(() => this.proposal());
			if (p && files && p.state !== 'applying' && !files.some((f) => f.path === p.path && f.status === 'conflicted')) {
				untracked(() => this.discardProposal());
			}
		});
	}

	private async checkCli(): Promise<void> {
		try {
			this.cli.set(await this.backend.agentAvailable());
		} catch {
			this.cli.set(null);
		}
	}

	/** True when Claude Code can be run; says why not otherwise. */
	private async ensureCli(): Promise<boolean> {
		if (!this.cli()) {
			await this.checkCli();
		}
		if (!this.cli()) {
			this.toast.error('Claude Code was not found', MISSING);
			return false;
		}
		return true;
	}

	private reset(): void {
		this.stopCommitMessage();
		this.suggestion.set(null);
		this.closeExplain();
		this.closeReview();
		this.discardProposal();
	}

	// ---- 1. commit message --------------------------------------------------

	/** Fill Summary and Description from the diff of the checked files. Calling it while it runs stops it. */
	async writeCommitMessage(): Promise<void> {
		if (this.writing()) {
			this.stopCommitMessage();
			this.toast.info('Stopped', 'No commit message was written.');
			return;
		}
		const id = this.repos.repo()?.id;
		const files = this.repos.includedFiles();
		if (!id) {
			return;
		}
		if (!files.length) {
			this.toast.info('Nothing to describe', 'Check the files you want to commit first.');
			return;
		}
		const run = ++this._commitRun;
		this.writing.set(true);
		this.suggestion.set(null);
		try {
			if (!(await this.ensureCli()) || run !== this._commitRun) {
				return;
			}
			const diff = await this.backend.aiSelectedDiff(id, files);
			if (run !== this._commitRun) {
				return;
			}
			const ask = this.ai.ask({
				prompt: commitMessagePrompt({ branch: this.repos.status()?.branch ?? '', files, diff: diff.text, truncated: diff.truncated, recent: diff.recent, typedSummary: this.repos.summary() }),
				tools: [],
				model: MODELS.commitMessage,
			});
			this._commitAsk = ask;
			const message = parseCommitMessage(await ask.result);
			if (run !== this._commitRun) {
				return;
			}
			if (!message) {
				throw new Error('Claude answered, but not with a commit message. Try again.');
			}
			// What the user typed (before or while this ran) is theirs: offer, do not overwrite.
			if (this.repos.summary().trim() || this.repos.description().trim()) {
				if (message.summary !== this.repos.summary().trim() || message.description !== this.repos.description().trim()) {
					this.suggestion.set(message);
				}
			} else {
				this.repos.summary.set(message.summary);
				this.repos.description.set(message.description);
			}
		} catch (e) {
			if (run === this._commitRun) {
				this.toast.error('Could not write a commit message', asAppError(e).message.slice(0, 400));
			}
		} finally {
			if (run === this._commitRun) {
				this._commitAsk = null;
				this.writing.set(false);
			}
		}
	}

	stopCommitMessage(): void {
		this._commitRun++;
		this._commitAsk?.cancel();
		this._commitAsk = null;
		this.writing.set(false);
	}

	/** Replace what is in the commit form with the suggested message. */
	takeSuggestion(): void {
		const s = this.suggestion();
		if (s) {
			this.repos.summary.set(s.summary);
			this.repos.description.set(s.description);
			this.suggestion.set(null);
		}
	}

	// ---- 2. explain ---------------------------------------------------------

	/** Explain one uncommitted file's diff, or one commit, in the side panel. */
	async explain(target: ExplainTarget): Promise<void> {
		const id = this.repos.repo()?.id;
		if (!id || !(await this.ensureCli())) {
			return;
		}
		this.stopExplain();
		const run = ++this._explainRun;
		const base: ExplainState =
			target.kind === 'file'
				? { target, title: fileName(target.file.path), detail: target.file.path, state: 'collecting', text: '', error: '' }
				: { target, title: `Commit ${target.commit.shortHash}`, detail: target.commit.summary, state: 'collecting', text: '', error: '' };
		this.explanation.set(base);
		this.panelTab.set('explain');
		try {
			const diff = target.kind === 'file' ? await this.backend.aiSelectedDiff(id, [target.file]) : await this.backend.aiCommitPatch(id, target.commit.hash);
			if (run !== this._explainRun) {
				return;
			}
			if (target.kind === 'file' && !diff.text.includes('@@')) {
				throw new Error('This file has no text changes to explain.');
			}
			const ask = this.ai.ask({
				prompt: explainPrompt(target, diff.text, diff.truncated),
				tools: [],
				model: MODELS.explain,
				onText: (text) => {
					if (run === this._explainRun) {
						this.explanation.set({ ...base, state: 'running', text });
					}
				},
			});
			this._explainAsk = ask;
			this.explanation.set({ ...base, state: 'running' });
			const answer = await ask.result;
			if (run === this._explainRun) {
				this.explanation.set({ ...base, state: 'done', text: answer.trim() });
			}
		} catch (e) {
			if (run === this._explainRun) {
				const error = asAppError(e).message.slice(0, 600);
				this.explanation.set({ ...base, state: 'error', text: this.explanation()?.text ?? '', error });
				this.toast.error('Could not explain this change', error.slice(0, 300));
			}
		} finally {
			if (run === this._explainRun) {
				this._explainAsk = null;
			}
		}
	}

	/** Keep what has been written so far. */
	stopExplain(): void {
		const s = this.explanation();
		this._explainRun++;
		this._explainAsk?.cancel();
		this._explainAsk = null;
		if (s && running(s.state)) {
			this.explanation.set({ ...s, state: 'stopped' });
		}
	}

	closeExplain(): void {
		this.stopExplain();
		this.explanation.set(null);
		if (this.reviewed()) {
			this.panelTab.set('review');
		}
	}

	// ---- 3. review before push ----------------------------------------------

	/** Review everything a push would send. Findings land in the side panel. */
	async review(): Promise<void> {
		const id = this.repos.repo()?.id;
		if (!id) {
			return;
		}
		if (running(this.reviewed()?.state)) {
			this.panelTab.set('review');
			return;
		}
		if (!(await this.ensureCli())) {
			return;
		}
		const run = ++this._reviewRun;
		const base: ReviewState = { state: 'collecting', range: null, summary: '', findings: [], error: '', raw: '', progress: '' };
		this._rangeDiffs.clear();
		this.reviewView.set(null);
		this.reviewed.set(base);
		this.panelTab.set('review');
		let state = base;
		try {
			const { text, ...range } = await this.backend.aiPushDiff(id);
			if (run !== this._reviewRun) {
				return;
			}
			if (!range.commits.length || !text.trim()) {
				this.reviewed.set(null);
				this.closePanelTab('review');
				this.toast.info('Nothing to review', range.commits.length ? 'The commits waiting to be pushed change no files.' : `This branch has no commits that ${range.against} does not already have.`);
				return;
			}
			state = { ...base, state: 'running', range };
			this.reviewed.set(state);
			const ask = this.ai.ask({
				prompt: reviewPrompt({ branch: this.repos.status()?.branch ?? '', against: range.against, commits: range.commits, files: range.files, diff: text, truncated: range.truncated }),
				tools: REVIEW_TOOLS,
				model: MODELS.review,
				onText: (soFar) => {
					// Before the answer Claude may say what it is looking up; the answer itself is JSON, not for showing.
					const last = soFar.trim().split(/\n{2,}/).pop() ?? '';
					if (run === this._reviewRun && last && !/^[`{[]/.test(last)) {
						this.reviewed.set({ ...state, progress: last.slice(0, 240) });
					}
				},
			});
			this._reviewAsk = ask;
			const answer = await ask.result;
			if (run !== this._reviewRun) {
				return;
			}
			const review = parseReview(answer, range.files.map((f) => f.path));
			if (!review) {
				const error = 'Claude answered, but not with a list of findings. Its answer is below.';
				this.reviewed.set({ ...state, state: 'error', error, raw: answer.trim() });
				this.toast.error('The review could not be read', 'Claude did not answer in the expected format. Run the review again.');
				return;
			}
			this.reviewed.set({ ...state, state: 'done', summary: review.summary, findings: review.findings });
		} catch (e) {
			if (run === this._reviewRun) {
				const error = asAppError(e).message.slice(0, 600);
				this.reviewed.set({ ...state, state: 'error', error });
				this.toast.error('The review did not finish', error.slice(0, 300));
			}
		} finally {
			if (run === this._reviewRun) {
				this._reviewAsk = null;
			}
		}
	}

	stopReview(): void {
		const s = this.reviewed();
		this._reviewRun++;
		this._reviewAsk?.cancel();
		this._reviewAsk = null;
		if (s && running(s.state)) {
			this.reviewed.set({ ...s, state: 'stopped' });
		}
	}

	closeReview(): void {
		this.stopReview();
		this.reviewed.set(null);
		this.reviewView.set(null);
		this._rangeDiffs.clear();
		this.closePanelTab('review');
	}

	private closePanelTab(tab: 'explain' | 'review'): void {
		if (this.panelTab() === tab) {
			this.panelTab.set(tab === 'review' ? 'explain' : 'review');
		}
	}

	/** Show a finding where it is: the file's diff over the reviewed range, in the main pane. */
	async openFinding(finding: Finding): Promise<void> {
		const id = this.repos.repo()?.id;
		const range = this.reviewed()?.range;
		if (!id || !range) {
			return;
		}
		const path = finding.file;
		const cached = this._rangeDiffs.get(path) ?? null;
		this.reviewView.set({ path, line: finding.line, diff: cached });
		if (cached) {
			return;
		}
		let diff: ParsedDiff;
		try {
			const res = await this.backend.aiRangeFileDiff(id, range.base, range.head, path);
			diff = parseDiff(res.text, res.tooLarge);
		} catch {
			diff = parseDiff('');
		}
		if (this.reviewed()?.range !== range) {
			return;
		}
		this._rangeDiffs.set(path, diff);
		const view = this.reviewView();
		if (view && view.path === path && !view.diff) {
			this.reviewView.set({ ...view, diff });
		}
	}

	closeReviewView(): void {
		this.reviewView.set(null);
	}

	// ---- 4. conflict resolution ---------------------------------------------

	proposalFor(path: string): ProposalState | null {
		const p = this.proposal();
		return p && p.path === path ? p : null;
	}

	/** Ask for a resolution of one conflicted file. The proposal is shown as a diff; nothing is written until it is accepted. */
	async proposeResolution(file: FileChange): Promise<void> {
		const repo = this.repos.repo();
		if (!repo || !(await this.ensureCli())) {
			return;
		}
		this.discardProposal();
		const run = ++this._proposalRun;
		const path = file.path;
		const base: ProposalState = { path, root: repo.worktree || repo.path, state: 'reading', conflicts: 0, original: '', text: '', summary: '', diff: null };
		this.proposal.set(base);
		try {
			const conflict = await this.backend.aiConflictFile(repo.id, path);
			if (run !== this._proposalRun) {
				return;
			}
			if (conflict.binary || conflict.tooLarge) {
				throw new Error(conflict.binary ? 'This is a binary file. Choose your version or theirs instead.' : 'This file is too large to send to Claude. Resolve it in your editor.');
			}
			const segments = parseConflicts(conflict.text);
			const conflicts = segments?.filter((s) => s.conflict).length ?? 0;
			if (!segments || !conflicts) {
				throw new Error(segments ? 'This file has no conflict markers: one side probably deleted or renamed it. Choose your version or theirs instead.' : 'The conflict markers in this file do not pair up, so it cannot be resolved automatically.');
			}
			if (conflictListing(segments).length > RESOLVE_MAX_CHARS) {
				throw new Error('The conflicts in this file are too large to send to Claude. Resolve it in your editor.');
			}
			const state: ProposalState = { ...base, state: 'running', conflicts, original: conflict.text };
			this.proposal.set(state);
			const ask = this.ai.ask({ prompt: resolvePrompt({ path, operation: this.repos.status()?.operation ?? null, segments }), tools: [], model: MODELS.resolve });
			this._proposalAsk = ask;
			const answer = await ask.result;
			if (run !== this._proposalRun) {
				return;
			}
			const resolution = applyResolutions(segments, answer);
			const res = await this.backend.aiResolutionPreview(repo.id, path, resolution.text);
			if (run !== this._proposalRun) {
				return;
			}
			this.proposal.set({ ...state, state: 'ready', text: resolution.text, summary: resolution.summary, diff: parseDiff(res.text, res.tooLarge) });
		} catch (e) {
			if (run === this._proposalRun) {
				this.proposal.set(null);
				this.toast.error('No resolution was proposed', asAppError(e).message.slice(0, 400));
			}
		} finally {
			if (run === this._proposalRun) {
				this._proposalAsk = null;
			}
		}
	}

	/** Write the proposal over the file and mark it resolved. */
	async acceptProposal(): Promise<void> {
		const id = this.repos.repo()?.id;
		const p = this.proposal();
		if (!id || !p || p.state !== 'ready') {
			return;
		}
		this.proposal.set({ ...p, state: 'applying' });
		try {
			await this.backend.aiResolutionApply(id, p.path, p.text, p.original, p.root);
			this.proposal.set(null);
			this.toast.success('Conflict resolved', `${fileName(p.path)} was written with the proposed resolution and marked as resolved. Look it over before you commit.`);
		} catch (e) {
			this.proposal.set(null);
			this.toast.error('The proposal was not applied', asAppError(e).message.slice(0, 400));
		}
		await this.repos.refresh();
	}

	/** Drop the proposal, stopping Claude if it is still working on it. */
	discardProposal(): void {
		this._proposalRun++;
		this._proposalAsk?.cancel();
		this._proposalAsk = null;
		this.proposal.set(null);
	}
}

// Built now rather than on first use: `computed()` hands itself to whichever component is
// rendering when it is created, and would be disposed with that component.
Injector.get(AiFeaturesStore);
