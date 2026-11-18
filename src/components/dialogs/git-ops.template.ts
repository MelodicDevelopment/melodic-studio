import { html } from '@melodicdev/core/template';
import type { GitOpsComponent, MergeMode } from './git-ops.component';
import type { RebaseAction } from '../../services/backend.service';
import { plural, relativeTime } from '../../shared/format';

const MODES: { value: MergeMode; label: string; detail: (branch: string, current: string) => string }[] = [
	{ value: 'merge', label: 'Merge', detail: (b, c) => `Adds a merge commit to ${c}; every commit of ${b} keeps its place in history.` },
	{ value: 'squash', label: 'Squash and merge', detail: (b, c) => `Everything ${b} changed becomes one new commit on ${c}. ${b} itself is left as it is.` },
	{ value: 'rebase', label: 'Rebase', detail: (b, c) => `Replays the commits of ${c} on top of ${b}, for a straight line. Rewrites them.` },
];

const ACTIONS: { value: RebaseAction; label: string }[] = [
	{ value: 'pick', label: 'Pick' },
	{ value: 'reword', label: 'Reword' },
	{ value: 'squash', label: 'Squash' },
	{ value: 'fixup', label: 'Fixup' },
	{ value: 'drop', label: 'Drop' },
];

const ACTION_HINT: Record<RebaseAction, string> = {
	pick: 'Keep as it is',
	reword: 'Keep, with a new message',
	squash: 'Fold into the commit above, combining messages',
	fixup: 'Fold into the commit above, dropping this message',
	drop: 'Leave out',
};

function dirtyWarning(self: GitOpsComponent) {
	return self.store.status()?.files.length
		? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>You have uncommitted changes. Git may refuse until they are committed or stashed.</span></p>`
		: '';
}

function mergeDialog(self: GitOpsComponent) {
	const store = self.store;
	const st = store.status();
	const branch = self.branch;
	const current = self.current;
	const n = self.incoming?.length ?? null;
	const mode = self.mode;
	return html`
		<ml-dialog #merge-branch style="--ml-dialog-max-width: 520px" @ml:open=${(e: Event) => e.target === e.currentTarget && void self.openedMerge()}>
			<h3 slot="dialog-header">Bring in ${branch}</h3>
			<div class="dlg">
				<p>${n === null ? html`Counting the commits on <b>${branch}</b>…` : n ? html`<b>${branch}</b> has ${plural(n, 'commit')} that <b>${current}</b> does not.` : html`<b>${current}</b> already has every commit on <b>${branch}</b>.`}</p>
				<div class="modes" role="radiogroup">
					${MODES.map(
						(m) => html`
							<button class="mode ${mode === m.value ? 'on' : ''}" role="radio" aria-checked=${mode === m.value ? 'true' : 'false'} @click=${() => (self.mode = m.value)}>
								<span class="dot"></span>
								<span class="text"><b>${m.label}</b><small>${m.detail(branch, current)}</small></span>
							</button>
						`,
					)}
				</div>
				${mode === 'squash'
					? html`
						<div class="squash-msg">
							<ml-input label="Commit message" .value=${self.squashSummary} @ml:input=${(e: CustomEvent) => (self.squashSummary = e.detail.value)}></ml-input>
							<ml-textarea rows="4" placeholder="Description" .value=${self.squashBody} @ml:input=${(e: CustomEvent) => (self.squashBody = e.detail.value)}></ml-textarea>
						</div>
					`
					: ''}
				${mode === 'rebase'
					? html`
						<p class="note">
							A branch that is already pushed will need a force push afterwards.
							<a @click=${() => self.chooseRebaseCommits()}>Choose, reorder or squash the commits first…</a>
						</p>
					`
					: ''}
				${dirtyWarning(self)}
				${mode !== 'rebase' ? html`<p class="note"><a @click=${() => self.pickInstead()}>Only want some of the commits? Cherry-pick them…</a></p>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('merge-branch')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!!st?.detached || (mode === 'squash' && (!self.squashSummary.trim() || n === 0))} @ml:click=${() => void self.submitMerge()}>
					${mode === 'rebase' ? 'Rebase' : mode === 'squash' ? 'Squash and merge' : 'Merge'}
				</ml-button>
			</div>
		</ml-dialog>
	`;
}

function pickDialog(self: GitOpsComponent) {
	const store = self.store;
	const list = self.incoming;
	const count = self.picked.size;
	const all = !!list?.length && list.every((c) => self.picked.has(c.hash));
	return html`
		<ml-dialog #cherry-pick style="--ml-dialog-max-width: 600px" @ml:open=${(e: Event) => e.target === e.currentTarget && void self.openedPick()}>
			<h3 slot="dialog-header">Cherry-pick from ${self.branch}</h3>
			<div class="dlg">
				<p>Copies the chosen commits onto <b>${self.current}</b> as new commits, oldest first. ${self.branch} is left as it is.</p>
				${list === null
					? html`<div class="loading"><ml-spinner size="md"></ml-spinner></div>`
					: !list.length
						? html`<p class="note">${self.current} already has every commit on ${self.branch}.</p>`
						: html`
							<div class="picklist">
								<label class="pickrow head">
									<input type="checkbox" .checked=${all} @change=${(e: Event) => self.pickAll((e.target as HTMLInputElement).checked)} />
									<span>Newest first</span>
								</label>
								${list.map(
									(c) => html`
										<label class="pickrow">
											<input type="checkbox" .checked=${self.picked.has(c.hash)} @change=${(e: Event) => self.togglePick(c.hash, (e.target as HTMLInputElement).checked)} />
											<code>${c.shortHash}</code>
											<span class="sum" title=${c.summary}>${c.summary}</span>
											<small>${c.authorName} · ${relativeTime(c.date)}</small>
										</label>
									`,
								)}
							</div>
						`}
				${dirtyWarning(self)}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('cherry-pick')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!count || !!store.status()?.detached} @ml:click=${() => void self.submitPick()}>
					${count ? `Cherry-pick ${plural(count, 'commit')}` : 'Cherry-pick'}
				</ml-button>
			</div>
		</ml-dialog>
	`;
}

function rebaseDialog(self: GitOpsComponent) {
	const store = self.store;
	const p = store.prompt();
	const rows = self.rows;
	const problem = self.planLoaded ? self.problem() : null;
	const pushed = rows.filter((r) => !r.commit.unpushed).length;
	const kept = rows.filter((r) => r.action !== 'drop').length;
	const title = p.branch ? `Rebase ${self.current} onto ${p.branch}` : 'Rewrite history';
	return html`
		<ml-dialog #rebase-interactive style="--ml-dialog-max-width: 760px" @ml:open=${(e: Event) => e.target === e.currentTarget && void self.openedRebase()}>
			<h3 slot="dialog-header">${title}</h3>
			<div class="dlg">
				<p>
					${p.branch
						? html`Replays these commits of <b>${self.current}</b> on top of <b>${p.branch}</b>, top to bottom.`
						: p.commit
							? html`The commits from <b>${p.commit.shortHash}</b> to the tip of <b>${self.current}</b>, oldest at the top. Git replays them top to bottom.`
							: html`Every commit of <b>${self.current}</b>, oldest at the top.`}
					Drag to reorder.
				</p>
				${!self.planLoaded
					? html`<div class="loading"><ml-spinner size="md"></ml-spinner></div>`
					: !rows.length
						? html`<p class="note">There are no commits to replay${p.branch ? `: ${self.current} has nothing that ${p.branch} lacks` : ''}.</p>`
						: html`
							<div class="rebase">
								${rows.map((r, i) => {
									const folds = r.action === 'squash' || r.action === 'fixup';
									const head = folds ? self.headOf(i) : -1;
									return html`
										<div class="row ${r.action} ${self.dragging === i ? 'dragging' : ''}">
											<span class="grip" title="Drag to reorder" @pointerdown=${(e: PointerEvent) => self.grab(e, i)}><ml-icon icon="dots-six-vertical" size="sm"></ml-icon></span>
											<ml-select class="act" size="sm" .options=${ACTIONS} .value=${r.action} title=${ACTION_HINT[r.action]} @ml:change=${(e: CustomEvent) => self.setAction(i, e.detail.value as RebaseAction)}></ml-select>
											<code>${r.commit.shortHash}</code>
											<span class="sum" title=${r.commit.summary}>${r.commit.summary}</span>
											${folds && head >= 0 ? html`<small class="into">into ${rows[head].commit.shortHash}</small>` : ''}
											${r.commit.unpushed ? '' : html`<ml-icon class="pushed" icon="cloud-check" size="sm" title="Already pushed"></ml-icon>`}
											<span class="moves">
												<button title="Move up" ?disabled=${i === 0} @click=${() => self.move(i, i - 1)}><ml-icon icon="caret-up" size="sm"></ml-icon></button>
												<button title="Move down" ?disabled=${i === rows.length - 1} @click=${() => self.move(i, i + 1)}><ml-icon icon="caret-down" size="sm"></ml-icon></button>
											</span>
										</div>
										${self.needsMessage(i)
											? html`
												<div class="msg">
													<ml-textarea size="sm" rows=${r.action === 'reword' && !self.members(i).length ? 3 : 5} .value=${self.messageOf(i)} @ml:input=${(e: CustomEvent) => self.setMessage(i, e.detail.value)}></ml-textarea>
												</div>
											`
											: ''}
									`;
								})}
							</div>
							<p class="legend">${ACTIONS.map((a) => html`<span><b>${a.label}</b> ${ACTION_HINT[a.value].toLowerCase()}</span>`)}</p>
						`}
				${problem ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>${problem}</span></p>` : ''}
				${self.planLoaded && rows.length && !kept ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>Every commit is dropped: ${self.current} ends up where ${p.branch ?? 'the starting point'} is.</span></p>` : ''}
				${pushed ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>${plural(pushed, 'commit')} here ${pushed === 1 ? 'is' : 'are'} already pushed. Rewriting ${pushed === 1 ? 'it' : 'them'} means a force push, and anyone who built on ${pushed === 1 ? 'it' : 'them'} has to recover.</span></p>` : ''}
				${store.status()?.files.length ? html`<p class="note">Your uncommitted changes are stashed for the rebase and put back afterwards.</p>` : ''}
				<p class="note">If a commit conflicts, the rebase stops there: resolve it in the Changes tab, then Continue (or Abort to put everything back).</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('rebase-interactive')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!self.planLoaded || !rows.length || !!problem || !self.changed()} @ml:click=${() => void self.submitRebase()}>
					${p.branch ? 'Rebase' : 'Rewrite history'}
				</ml-button>
			</div>
		</ml-dialog>
	`;
}

export function gitOpsTemplate(self: GitOpsComponent) {
	return html`${mergeDialog(self)}${pickDialog(self)}${rebaseDialog(self)}`;
}
