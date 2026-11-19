import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html } from '@melodicdev/core/template';
import { AgentsStore, stateOf, type AgentSession, type Investigation } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import type { InvestigateApproval, WorktreeDiff } from '../../services/backend.service';
import { INVESTIGATE_STEPS, type Evidence, type InvestigationReport, type PathStep } from '../../services/ai-prompts';
import { parseDiff, type ParsedDiff } from '../../shared/diff';
import { fileName } from '../../shared/paths';
import { plural } from '../../shared/format';
import { richText, type RichOptions } from '../agents/rich-text';
import { fileRef } from '../agents/rich-text';
import { investigationStyles } from './investigation.styles';

const TOOL_ICONS: Record<string, string> = { Read: 'file-text', Edit: 'pencil-simple', Write: 'file-plus', Bash: 'terminal-window', Grep: 'magnifying-glass', Glob: 'magnifying-glass' };
const STATUS_LABELS: Record<Evidence['status'], string> = { 'ruled-out': 'Ruled out', confirmed: 'Confirmed', 'also-found': 'Also found' };

/** "3 min", "under a minute", "1 h 5 min". */
export function took(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) {
		return 'under a minute';
	}
	return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const eq = () => html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b><b></b></span>`;
const sparkle = () => html`<ml-icon icon="sparkle" size="sm"></ml-icon>`;

/** What Claude asks to run, in a sentence, with the command or request it would be. */
function approvalCard(self: InvestigationComponent, s: AgentSession, i: Investigation, a: InvestigateApproval) {
	// The project when the target has one ("Shop.Api", "Shop.Tests"); a script in a package.json is known by its own name.
	const project = a.project ?? a.target ?? 'the app';
	const always = i.targetName ?? 'this repository';
	let title: string;
	let what: unknown;
	if (a.tool === 'http_request') {
		title = 'Claude wants to send a request to its copy of the app';
		what = html`
			<p>It goes to the copy running from the worktree${a.port ? html` on port <span class="mono">${a.port}</span>` : ''}, not to the one you are running.</p>
			<pre class="cmd">${a.method ?? 'GET'} ${a.path ?? '/'}${a.body ? `\n\n${a.body}` : ''}</pre>
		`;
	} else if (a.tool === 'run_tests') {
		title = `Claude wants to run ${a.project ?? a.target ?? 'the tests'}`;
		what = html`
			<p>This runs the tests in the worktree, with its recording in place.</p>
			<pre class="cmd">${a.command ?? ''}</pre>
		`;
	} else {
		title = `Claude wants to run ${project}`;
		what = html`
			<p>This starts a copy of ${project} from the worktree${a.port ? html` on port <span class="mono">${a.port}</span>` : ''}, so it does not collide with the one you are running.</p>
			<pre class="cmd">${a.command ?? ''}</pre>
		`;
	}
	return html`
		<div class="card you" role="alertdialog" aria-label=${title}>
			<div class="ctitle">${title}</div>
			${what}
			${a.touches ? html`<p class="touches"><b>What it touches, according to Claude:</b> ${a.touches}</p>` : html`<p class="touches">Claude did not say what this touches outside the worktree.</p>`}
			<div class="btns">
				<ml-button variant="primary" @ml:click=${() => self.agents.allow(s.id)}>Allow once</ml-button>
				<ml-button variant="outline" title=${`Everything this and later investigations of ${always} ask to run is allowed without asking`} @ml:click=${() => self.agents.allow(s.id, true)}>Always allow for ${always}</ml-button>
				<ml-button variant="ghost" @ml:click=${() => self.agents.deny(s.id)}>Don't run</ml-button>
			</div>
		</div>
	`;
}

/** The six steps, with what Claude said under each. The one it is on waits (magenta) or runs (azure). */
function checklist(i: Investigation, running: boolean) {
	// Before Claude has said where it is, it is reading.
	const at = i.step || (running ? 1 : 0);
	return html`
		<ol class="steps">
			${INVESTIGATE_STEPS.map((title, index) => {
				const n = index + 1;
				const state = n < at || (!running && n <= at && !!i.report) ? 'done' : n === at && running ? (i.approval ? 'waiting' : 'now') : 'todo';
				const detail = i.details[String(n)] ?? '';
				return html`
					<li class=${state}>
						<span class="mark">${state === 'done' ? html`<ml-icon icon="check" format="bold" size="xs"></ml-icon>` : ''}</span>
						<div>
							<span class="stitle">${title}</span>
							${state === 'waiting' ? html`<span class="sdetail">Waiting for your OK</span>` : detail ? html`<span class="sdetail">${detail}</span>` : ''}
						</div>
					</li>
				`;
			})}
		</ol>
	`;
}

function transcript(self: InvestigationComponent, s: AgentSession, links: RichOptions) {
	return html`
		<div class="log">
			${s.items.map((item) =>
				item.kind === 'tool'
					? html`<div class="tool"><ml-icon icon=${TOOL_ICONS[item.text] ?? (item.text.startsWith('mcp__') ? 'sparkle' : 'wrench')} size="sm"></ml-icon><b>${item.text.replace(/^mcp__studio__/, '')}</b><span>${item.detail ?? ''}</span></div>`
					: item.kind === 'text'
						? html`<div class="msg text">${item.text.trim().startsWith('{') ? html`<pre class="json">${item.text}</pre>` : richText(item.text, links, self.follow)}</div>`
						: html`<div class="msg ${item.kind}">${item.text}</div>`
			)}
		</div>
	`;
}

function investigating(self: InvestigationComponent, s: AgentSession, i: Investigation, links: RichOptions) {
	const running = s.status === 'running';
	const state = stateOf(s);
	const title = running ? (i.checking ? 'Checking the fix' : 'Investigating') : state === 'failed' ? 'The investigation failed' : state === 'stopped' ? 'Investigation stopped' : 'Investigation ended without a report';
	const last = [...s.items].reverse().find((item) => item.kind === 'error' || item.kind === 'text');
	return html`
		<div class="pane">
			<header class="top">
				<div class="tile ${running ? '' : 'idle'}">${running ? eq() : html`<ml-icon icon=${state === 'failed' ? 'warning' : 'pause'} size="md"></ml-icon>`}</div>
				<div class="grow">
					<h1>${title}</h1>
					<div class="sub">${i.summary}</div>
					<div class="chips">
						<span class="chip run mono" title=${s.cwd}>worktree&nbsp; ${s.branch ?? ''}</span>
						${i.port ? html`<span class="chip mono">its own port&nbsp; ${i.port}</span>` : ''}
						<span class="chip">Your files are untouched</span>
					</div>
				</div>
				<ml-button variant="ghost" size="sm" @ml:click=${() => (self.showLog = !self.showLog)}>${self.showLog ? 'Hide transcript' : 'Transcript'}</ml-button>
				${running ? html`<ml-button variant="outline" size="sm" @ml:click=${() => self.agents.stop(s.id)}>Stop</ml-button>` : ''}
			</header>
			${self.showLog
				? transcript(self, s, links)
				: html`
					<div class="cols">
						${checklist(i, running)}
						<div class="side">
							${i.approval ? approvalCard(self, s, i, i.approval) : ''}
							${i.thinking
								? html`
									<div class="card ai">
										<div class="clabel">${sparkle()}Claude's thinking so far</div>
										<div class="said">${richText(i.thinking, links, self.follow)}</div>
									</div>
								`
								: ''}
							${!running && last ? html`<div class="card ${last.kind === 'error' ? 'bad' : ''}"><div class="said">${last.kind === 'text' ? richText(last.text, links, self.follow) : last.text}</div></div>` : ''}
						</div>
					</div>
				`}
			${running ? '' : followUp(self, s, 'Tell Claude how to carry on, or what it missed')}
		</div>
	`;
}

function pathCard(self: InvestigationComponent, step: PathStep) {
	const where = step.file ? `${fileName(step.file)}${step.line ? `:${step.line}` : ''}` : '';
	return html`
		<div class="pcard ${step.role ?? ''}">
			${step.file
				? html`<a href="#" class="fn" title=${`Open ${step.file}${step.line ? ` at line ${step.line}` : ''}`} @click=${(e: Event) => (e.preventDefault(), self.open(step.file, step.line))}>${step.fn || where}</a>`
				: html`<span class="fn">${step.fn}</span>`}
			${where ? html`<span class="where">${where}</span>` : ''}
			<span class="vals">${step.values.map(([name, value]) => html`<span>${name} = ${value}</span>`)}</span>
			${step.role ? html`<span class="role">${step.role === 'cause' ? 'The cause' : 'The crash'}</span>` : ''}
		</div>
	`;
}

function evidenceRow(self: InvestigationComponent, e: Evidence, links: RichOptions) {
	return html`
		<div class="erow ${e.status}">
			<span class="tag">${STATUS_LABELS[e.status]}</span>
			<div class="ebody">
				<span class="etitle">${e.title}</span>
				${e.detail ? html`<div class="said">${richText(e.detail, links, self.follow)}</div>` : ''}
				${e.refs.length
					? html`<div class="refs">
							${e.refs.map((r) => {
								const ref = fileRef(r, true, null);
								return ref ? html`<a href="#" @click=${(ev: Event) => (ev.preventDefault(), self.open(ref.path, ref.line))}>${r}</a>` : html`<span>${r}</span>`;
							})}
						</div>`
					: ''}
			</div>
		</div>
	`;
}

function fix(self: InvestigationComponent, s: AgentSession, i: Investigation, report: InvestigationReport) {
	const diff = self.diff;
	const files = diff?.files ?? [];
	const test = report.test;
	return html`
		<section class="fix">
			<h2>The fix</h2>
			${self.diffError ? html`<div class="none">${self.diffError}</div>` : !diff ? html`<div class="none"><ml-spinner size="sm"></ml-spinner></div>` : ''}
			${diff && !files.length ? html`<div class="none">Claude changed nothing in the code. ${report.found ? 'Ask it below to write the fix.' : ''}</div>` : ''}
			${files.map((f, n) => {
				const parsed = self.parsed[n];
				return html`
					<div class="dfile">
						<div class="dhead"><span class="mono">${f.path}</span>${parsed && (parsed.added || parsed.removed) ? html`<span><b class="add">+${parsed.added}</b> <b class="del">−${parsed.removed}</b></span>` : ''}</div>
						<ms-diff .diff=${parsed ?? null} .emptyText=${f.status === 'deleted' ? 'Deleted.' : 'No content changes.'}></ms-diff>
					</div>
				`;
			})}
			${test
				? html`
					<div class="test">
						<ml-icon icon=${test.failsBefore && test.passesAfter ? 'check' : 'warning'} format="bold" size="sm"></ml-icon>
						<span>New test <span class="mono">${test.name}</span>: ${test.failsBefore ? 'fails before' : 'not seen failing before'}, ${test.passesAfter ? 'passes after' : 'not seen passing after'}</span>
					</div>
				`
				: files.length
					? html`<div class="test dim"><ml-icon icon="warning" size="sm"></ml-icon><span>Claude did not add a test for this.</span></div>`
					: ''}
			${i.leftover.length
				? html`
					<p class="warn">
						<ml-icon icon="warning" size="sm"></ml-icon>
						<span>Recording is still in ${plural(i.leftover.length, 'file')} (${i.leftover.map((p) => fileName(p)).join(', ')}), so the fix is not offered yet.</span>
					</p>
					<div class="btns">
						<ml-button variant="outline" @ml:click=${() => self.askCleanup(s)}>Ask Claude to remove it</ml-button>
						<ml-button variant="outline" @ml:click=${() => self.agents.review(s)}>Review in Changes</ml-button>
						<ml-button variant="ghost" @ml:click=${() => self.discard(s)}>Discard</ml-button>
					</div>
				`
				: html`
					<div class="btns">
						<ml-button variant="primary" ?disabled=${!files.length || !!self.repos.busy()} @ml:click=${() => self.accept()}>Accept fix</ml-button>
						<ml-button variant="outline" ?disabled=${!files.length} @ml:click=${() => self.agents.review(s)}>Review in Changes</ml-button>
						<ml-button variant="ghost" @ml:click=${() => self.discard(s)}>Discard</ml-button>
					</div>
					${files.length ? html`<p class="foot">The recording Claude added is gone. Only the fix${test ? ' and the test are' : ' is'} left.</p>` : ''}
				`}
		</section>
	`;
}

function followUp(self: InvestigationComponent, s: AgentSession, placeholder: string) {
	return html`
		<form class="follow" @submit=${(e: Event) => (e.preventDefault(), self.send(s))}>
			${sparkle()}
			<label class="sr" for="followup">Ask a follow-up</label>
			<input id="followup" autocomplete="off" placeholder=${placeholder} .value=${self.draft} @input=${(e: Event) => (self.draft = (e.target as HTMLInputElement).value)} />
			<button type="submit" ?disabled=${!self.draft.trim()}>Ask</button>
		</form>
	`;
}

function report(self: InvestigationComponent, s: AgentSession, i: Investigation, r: InvestigationReport, links: RichOptions) {
	const time = took((i.ended ?? Date.now()) - i.started);
	return html`
		<div class="pane report">
			<header class="top">
				<div class="grow">
					<div class="verdict ${r.found ? 'found' : 'open'}">
						<ml-icon icon=${r.found ? 'check' : 'question'} format="bold" size="sm"></ml-icon>
						${r.found ? 'Cause found' : 'No cause found'} · ${time} · ${plural(i.runs, 'run')}
					</div>
					<h1 class="cause">${r.summary}</h1>
				</div>
				<ml-button variant="ghost" size="sm" @ml:click=${() => (self.showLog = !self.showLog)}>${self.showLog ? 'Back to the report' : 'Transcript'}</ml-button>
			</header>
			${self.showLog
				? transcript(self, s, links)
				: html`
					<div class="scroll">
						${r.path.length
							? html`
								<section>
									<div class="shead">
										<h2>The path it took</h2>
										${r.run
											? html`<button class="replay" title="Step through the recorded run, forwards and backwards" @click=${() => self.agents.replaying.set(s.id)}><ml-icon icon="play" format="fill" size="sm"></ml-icon>Open Replay</button>`
											: ''}
									</div>
									<div class="path">
										${r.path.map((step, n) => html`${n ? html`<ml-icon class="arrow" icon="arrow-right" size="sm"></ml-icon>` : ''}${pathCard(self, step)}`)}
									</div>
								</section>
							`
							: r.run
								? html`<div class="shead"><span class="grow"></span><button class="replay" @click=${() => self.agents.replaying.set(s.id)}><ml-icon icon="play" format="fill" size="sm"></ml-icon>Open Replay</button></div>`
								: ''}
						<div class="two">
							<section class="evidence">
								<h2>The evidence</h2>
								${r.evidence.length ? r.evidence.map((e) => evidenceRow(self, e, links)) : html`<div class="none">Claude listed no evidence. Ask it below what it tested.</div>`}
							</section>
							${fix(self, s, i, r)}
						</div>
					</div>
				`}
			${followUp(self, s, r.found ? 'Ask a follow-up: Claude may run and record again' : 'Tell Claude what else to try')}
		</div>
	`;
}

/**
 * The main pane for an investigation: while it runs, the checklist Claude advances with the
 * approval card and its thinking beside it; at the end, the report (cause, path, evidence, fix).
 * Everything shown from the program or from Claude is text, never HTML.
 */
@MelodicComponent({
	selector: 'ms-investigation',
	template: (self: InvestigationComponent) => {
		const s = self.agents.selected();
		const i = s?.investigation;
		if (!s || !i) {
			return html`<span hidden></span>`;
		}
		if (self.agents.replaying() === s.id && i.report?.run) {
			return html`<ms-replay></ms-replay>`;
		}
		// Links open in the checkout on screen: the user's own code, where the failure is.
		const links: RichOptions = { files: true, commits: false, root: s.cwd };
		// A report stands while nothing is running: a follow-up turn shows the checklist again.
		return i.report && s.status !== 'running' && !i.checking ? report(self, s, i, i.report, links) : investigating(self, s, i, links);
	},
	styles: investigationStyles,
})
export class InvestigationComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	elementRef!: HTMLElement;

	draft = '';
	showLog = false;
	/** What the worktree holds that the commit it started from does not: the fix. */
	diff: WorktreeDiff | null = null;
	parsed: ParsedDiff[] = [];
	diffError = '';
	private _diffFor = '';

	/** The fix is the worktree's diff, read again whenever a turn of the session on screen has ended. */
	onRender(): void {
		const s = this.agents.selected();
		const i = s?.investigation;
		const key = s && i?.report && s.status !== 'running' && !i.checking ? `${s.id}:${i.ended ?? 0}:${s.updated}` : '';
		if (key === this._diffFor) {
			return;
		}
		this._diffFor = key;
		if (!s || !key) {
			return;
		}
		this.showLog = false;
		this.diff = null;
		this.diffError = '';
		void this.agents
			.changes(s)
			.then((data) => {
				if (this._diffFor === key) {
					this.diff = data;
					this.parsed = data.files.map((f) => parseDiff(f.diff));
				}
			})
			.catch(() => {
				if (this._diffFor === key) {
					this.diffError = 'The worktree could not be read. It may have been removed.';
				}
			});
		if (s.unread && document.visibilityState === 'visible') {
			const id = s.id;
			queueMicrotask(() => this.agents.seen(id));
		}
	}

	/** A link in what Claude wrote. */
	readonly follow = (ref: Parameters<AgentsStore['follow']>[1]): void => {
		const s = this.agents.selected();
		if (s) {
			void this.agents.follow(s, ref);
		}
	};

	open(path: string, line: number | null): void {
		const s = this.agents.selected();
		if (s && path) {
			void this.agents.openFile(s, path, line);
		}
	}

	send(s: AgentSession): void {
		if (this.draft.trim()) {
			void this.agents.send(s.id, this.draft);
			this.draft = '';
		}
	}

	askCleanup(s: AgentSession): void {
		void this.agents.send(s.id, 'Recording is still in the worktree. Remove every line that ends in the studio-replay marker and delete the helper file, changing nothing else.');
	}

	/** The session pane owns the Merge dialog: it is told through an event, as any child would tell its parent. */
	accept(): void {
		this.elementRef.dispatchEvent(new CustomEvent('accept'));
	}

	discard(s: AgentSession): void {
		this.elementRef.dispatchEvent(new CustomEvent('discard', { detail: s.id }));
	}
}
