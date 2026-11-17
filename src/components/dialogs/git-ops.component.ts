import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { RepoStore } from '../../services/repo.store';
import type { Commit, RebaseAction, RebaseStep } from '../../services/backend.service';
import { gitOpsTemplate } from './git-ops.template';
import { gitOpsStyles } from './git-ops.styles';

export type MergeMode = 'merge' | 'squash' | 'rebase';

/** One line of the interactive rebase list. `message` is null until the user edits it. */
export interface RebaseRow {
	commit: Commit;
	action: RebaseAction;
	message: string | null;
}

/** A commit's whole message, as git keeps it. */
export function fullMessage(c: Commit): string {
	return c.body ? `${c.summary}\n\n${c.body}` : c.summary;
}

/**
 * The dialogs for the bigger git operations: merge (plain, squash, rebase), cherry-pick a choice of
 * commits from another branch, and the interactive rebase editor (reorder, reword, squash, fixup,
 * drop). Opened by id through `RepoStore.ask()` like the rest.
 */
@MelodicComponent({
	selector: 'ms-git-ops',
	template: gitOpsTemplate,
	styles: gitOpsStyles,
})
export class GitOpsComponent {
	@Service(RepoStore) readonly store!: RepoStore;

	elementRef!: HTMLElement;

	// ---- merge ----
	mode: MergeMode = 'merge';
	squashSummary = '';
	squashBody = '';
	/** What the branch brings in, newest first; null while loading. */
	incoming: Commit[] | null = null;

	// ---- cherry-pick ----
	picked: ReadonlySet<string> = new Set();

	// ---- interactive rebase ----
	rows: RebaseRow[] = [];
	planLoaded = false;
	/** Index of the row being dragged by its grip. */
	dragging: number | null = null;
	private _initialOrder: string[] = [];

	get branch(): string {
		return this.store.prompt().branch ?? '';
	}

	get current(): string {
		const st = this.store.status();
		return st?.detached ? 'this commit' : (st?.branch ?? 'this branch');
	}

	// ---- merge ----

	async openedMerge(): Promise<void> {
		const p = this.store.prompt();
		this.mode = p.rebase ? 'rebase' : p.squash ? 'squash' : 'merge';
		this.incoming = null;
		this.squashSummary = `Squash merge ${this.branch} into ${this.current}`;
		this.squashBody = '';
		const branch = this.branch;
		const list = await this.store.incoming(branch);
		if (branch !== this.branch) {
			return;
		}
		this.incoming = list;
		this.squashBody = [...list].reverse().map((c) => `* ${c.summary}`).join('\n');
	}

	async submitMerge(): Promise<void> {
		const branch = this.branch;
		const mode = this.mode;
		if (mode === 'squash' && !this.squashSummary.trim()) {
			return;
		}
		this.store.closeDialog('merge-branch');
		if (mode === 'rebase') {
			await this.store.rebaseOnto(branch);
		} else if (mode === 'squash') {
			const body = this.squashBody.trim();
			await this.store.mergeSquash(branch, body ? `${this.squashSummary.trim()}\n\n${body}` : this.squashSummary.trim());
		} else {
			await this.store.merge(branch);
		}
	}

	/** From the merge dialog's rebase choice to the editor, with the same branch. */
	chooseRebaseCommits(): void {
		const branch = this.branch;
		this.store.closeDialog('merge-branch');
		this.store.ask('rebase-interactive', { branch, upstream: branch });
	}

	pickInstead(): void {
		const branch = this.branch;
		this.store.closeDialog('merge-branch');
		this.store.ask('cherry-pick', { branch });
	}

	// ---- cherry-pick ----

	async openedPick(): Promise<void> {
		const p = this.store.prompt();
		this.picked = new Set(p.hashes ?? []);
		this.incoming = null;
		const branch = this.branch;
		const list = await this.store.incoming(branch);
		if (branch === this.branch) {
			this.incoming = list;
		}
	}

	togglePick(hash: string, on: boolean): void {
		const next = new Set(this.picked);
		if (on) {
			next.add(hash);
		} else {
			next.delete(hash);
		}
		this.picked = next;
	}

	pickAll(on: boolean): void {
		this.picked = new Set(on ? (this.incoming ?? []).map((c) => c.hash) : []);
	}

	async submitPick(): Promise<void> {
		// The list is newest first; git applies them in the order given, so oldest first.
		const hashes = [...(this.incoming ?? [])].reverse().filter((c) => this.picked.has(c.hash)).map((c) => c.hash);
		if (!hashes.length) {
			return;
		}
		this.store.closeDialog('cherry-pick');
		await this.store.cherryPick(hashes);
	}

	// ---- interactive rebase ----

	async openedRebase(): Promise<void> {
		const p = this.store.prompt();
		this.rows = [];
		this.planLoaded = false;
		const upstream = p.upstream ?? null;
		const plan = await this.store.rebasePlan(upstream);
		if ((this.store.prompt().upstream ?? null) !== upstream) {
			return;
		}
		const reword = new Set(p.hashes ?? []);
		this.rows = (plan ?? []).map((commit) => ({ commit, action: reword.has(commit.hash) ? 'reword' : 'pick', message: null }));
		this._initialOrder = this.rows.map((r) => r.commit.hash);
		this.planLoaded = true;
		if (plan === null) {
			this.store.closeDialog('rebase-interactive');
		}
	}

	/** Index of the pick/reword a squash or fixup at `i` folds into, or -1. */
	headOf(i: number): number {
		for (let j = i - 1; j >= 0; j--) {
			const a = this.rows[j].action;
			if (a === 'pick' || a === 'reword') {
				return j;
			}
		}
		return -1;
	}

	/** The squash and fixup rows that fold into the pick/reword at `i`. */
	members(i: number): RebaseRow[] {
		const out: RebaseRow[] = [];
		for (let j = i + 1; j < this.rows.length; j++) {
			const a = this.rows[j].action;
			if (a === 'pick' || a === 'reword') {
				break;
			}
			if (a !== 'drop') {
				out.push(this.rows[j]);
			}
		}
		return out;
	}

	/** A pick/reword gets a message box when it is reworded or a squash folds into it. */
	needsMessage(i: number): boolean {
		const r = this.rows[i];
		if (r.action !== 'pick' && r.action !== 'reword') {
			return false;
		}
		return r.action === 'reword' || this.members(i).some((m) => m.action === 'squash');
	}

	/** What git would write: the commit's own message, plus every squashed one after it. */
	defaultMessage(i: number): string {
		const r = this.rows[i];
		const squashed = this.members(i).filter((m) => m.action === 'squash');
		return [r.commit, ...squashed.map((m) => m.commit)].map(fullMessage).join('\n\n');
	}

	messageOf(i: number): string {
		return this.rows[i].message ?? this.defaultMessage(i);
	}

	setAction(i: number, action: RebaseAction): void {
		this.rows = this.rows.map((r, j) => (j === i ? { ...r, action } : r));
	}

	setMessage(i: number, message: string): void {
		this.rows = this.rows.map((r, j) => (j === i ? { ...r, message } : r));
	}

	move(from: number, to: number): void {
		if (to < 0 || to >= this.rows.length || from === to) {
			return;
		}
		const next = [...this.rows];
		const [row] = next.splice(from, 1);
		next.splice(to, 0, row);
		this.rows = next;
	}

	/** Drag a row by its grip. Pointer events, not HTML drag and drop, which the desktop window's file drop handling gets in the way of. */
	grab(e: PointerEvent, i: number): void {
		e.preventDefault();
		const grip = e.currentTarget as HTMLElement;
		grip.setPointerCapture(e.pointerId);
		this.dragging = i;
		const moveTo = (ev: PointerEvent): void => {
			if (this.dragging === null) {
				return;
			}
			const rows = [...(this.elementRef.shadowRoot?.querySelectorAll<HTMLElement>('.rebase .row') ?? [])];
			let target = rows.length - 1;
			for (let k = 0; k < rows.length; k++) {
				const box = rows[k].getBoundingClientRect();
				if (ev.clientY < box.top + box.height / 2) {
					target = k;
					break;
				}
			}
			if (target !== this.dragging) {
				this.move(this.dragging, target);
				this.dragging = target;
			}
		};
		const end = (): void => {
			this.dragging = null;
			grip.removeEventListener('pointermove', moveTo);
			grip.removeEventListener('pointerup', end);
			grip.removeEventListener('pointercancel', end);
		};
		grip.addEventListener('pointermove', moveTo);
		grip.addEventListener('pointerup', end);
		grip.addEventListener('pointercancel', end);
	}

	/** Why the list cannot run as it is, if it cannot. */
	problem(): string | null {
		if (this.rows.some((r) => r.commit.parents.length > 1)) {
			return 'These commits include a merge, which an interactive rebase would flatten. Start after the merge.';
		}
		const first = this.rows.find((r) => r.action !== 'drop');
		if (first && (first.action === 'squash' || first.action === 'fixup')) {
			return `The first kept commit (${first.commit.shortHash}) cannot be squashed or fixed up: there is nothing above it to fold into.`;
		}
		if (this.rows.some((r, i) => this.needsMessage(i) && !this.messageOf(i).trim())) {
			return 'Every reworded or squashed commit needs a message.';
		}
		return null;
	}

	/** Anything other than replaying every commit as it is. A rebase onto a branch is a change by itself. */
	changed(): boolean {
		if (this.store.prompt().branch) {
			return true;
		}
		return this.rows.some((r) => r.action !== 'pick' || r.message !== null) || this.rows.map((r) => r.commit.hash).join() !== this._initialOrder.join();
	}

	steps(): RebaseStep[] {
		return this.rows.map((r, i) => ({ hash: r.commit.hash, action: r.action, message: this.needsMessage(i) ? this.messageOf(i) : null }));
	}

	async submitRebase(): Promise<void> {
		if (this.problem() || !this.rows.length) {
			return;
		}
		const upstream = this.store.prompt().upstream ?? null;
		const steps = this.steps();
		this.store.closeDialog('rebase-interactive');
		await this.store.rebaseInteractive(upstream, steps);
	}
}
