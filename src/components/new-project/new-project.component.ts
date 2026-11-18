import { MelodicComponent } from '@melodicdev/core/components';
import { Injector, Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { BackendService, asAppError, type ProjectOutput, type ProjectTemplate, type TemplateOption } from '../../services/backend.service';
import { RepoStore } from '../../services/repo.store';
import { InitService } from '../init/init-repo.component';
import { dirName, joinPath } from '../../shared/paths';

type DialogId = Parameters<DialogService['close']>[0];
const PARENT_KEY = 'studio.new-project.parent';
const TEMPLATE_KEY = 'studio.new-project.template';
const GROUPS: { id: ProjectTemplate['group']; label: string }[] = [
	{ id: 'melodic', label: 'Melodic' },
	{ id: 'popular', label: 'Popular' },
	{ id: 'blank', label: 'Other' },
];

function saved(key: string): string {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}
function keep(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* per-viewer convenience only */
	}
}

/**
 * File > New Project: pick a template, a name and a folder; the template's own tool makes the project,
 * then the setup wizard takes over (git, .gitignore, first commit, where the repository lives).
 */
@MelodicComponent({
	selector: 'ms-new-project',
	template: (self: NewProjectComponent) => {
		const t = self.current;
		const running = self.state === 'running';
		const locked = running || self.state === 'done';
		return html`
			<ml-dialog #new-project style="--ml-dialog-max-width: 760px" @ml:open=${(e: Event) => e.target === e.currentTarget && void self.opened()}>
				<h3 slot="dialog-header">New project</h3>
				<div class="body">
					<div class="list ${locked ? 'off' : ''}">
						${GROUPS.map((g) => {
							const items = self.templates.filter((x) => x.group === g.id);
							return items.length
								? html`
									<div class="group">${g.label}</div>
									${items.map((x) => {
										const missing = x.tools.find((tool) => !tool.found);
										return html`
											<button class="tpl ${x.id === self.picked ? 'on' : ''} ${missing ? 'missing' : ''}" @click=${() => self.pick(x.id)}>
												<ml-icon icon=${x.icon} size="md"></ml-icon>
												<span><b>${x.name}</b><small>${missing ? `Needs ${missing.name}` : x.description}</small></span>
											</button>
										`;
									})}
								`
								: '';
						})}
					</div>
					<div class="form">
						${t ? form(self, t, locked) : html`<div class="note"><ml-spinner size="md"></ml-spinner></div>`}
						${self.log.length || running
							? html`
								<div class="log" role="log">
									${self.log.map((l) => html`<div class=${l.kind}>${l.text}</div>`)}
									${running ? html`<div class="out"><ml-spinner size="sm"></ml-spinner></div>` : ''}
								</div>
							`
							: ''}
						${self.error ? html`<ml-alert variant="danger">${self.error}</ml-alert>` : ''}
					</div>
				</div>
				<div slot="dialog-footer" class="foot">
					${running
						? html`<ml-button variant="outline" @ml:click=${() => void self.stop()}>Stop</ml-button>`
						: html`
							<ml-button variant="outline" @ml:click=${() => self.close()}>Cancel</ml-button>
							<ml-button variant="primary" ?disabled=${!self.canCreate} @ml:click=${() => void self.create()}>Create</ml-button>
						`}
				</div>
			</ml-dialog>
		`;
	},
	styles: () => css`
		.body {
			display: grid;
			grid-template-columns: 250px 1fr;
			gap: 18px;
			min-height: 440px;
			color: var(--ml-color-text-secondary);
		}
		.list {
			display: flex;
			flex-direction: column;
			gap: 3px;
			max-height: 520px;
			overflow-y: auto;
			padding-right: 4px;
		}
		.list.off {
			opacity: 0.55;
			pointer-events: none;
		}
		.group {
			margin: 8px 0 2px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.group:first-child {
			margin-top: 0;
		}
		.tpl {
			all: unset;
			display: flex;
			gap: 10px;
			align-items: center;
			padding: 7px 9px;
			border-radius: 8px;
			cursor: pointer;
			color: var(--ml-color-text);
		}
		.tpl:hover {
			background: var(--ms-hover);
		}
		.tpl.on {
			background: var(--ms-hover);
			box-shadow: inset 0 0 0 1px var(--ml-color-primary);
		}
		.tpl span {
			display: flex;
			flex-direction: column;
			min-width: 0;
		}
		.tpl small {
			color: var(--ml-color-text-muted);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.tpl.missing small {
			color: var(--ml-color-warning, var(--ml-color-text-muted));
		}
		.form {
			display: flex;
			flex-direction: column;
			gap: 12px;
			min-width: 0;
		}
		.form p {
			margin: 0;
			line-height: 1.5;
		}
		.pathrow {
			display: flex;
			gap: 8px;
			align-items: flex-end;
		}
		.pathrow ml-input {
			flex: 1;
		}
		.where {
			font-family: var(--ml-font-mono);
			font-size: 12px;
			color: var(--ml-color-text-muted);
			word-break: break-all;
		}
		.needs {
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 10px 12px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
		}
		.needs a {
			color: var(--ml-color-primary);
			cursor: pointer;
		}
		.log {
			flex: 1;
			min-height: 120px;
			max-height: 220px;
			overflow-y: auto;
			padding: 8px 10px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
			background: var(--ml-color-surface-sunken, var(--ml-color-surface));
			font-family: var(--ml-font-mono);
			font-size: 11.5px;
			line-height: 1.5;
			white-space: pre-wrap;
			word-break: break-word;
		}
		.log .step {
			margin-top: 6px;
			color: var(--ml-color-text);
			font-weight: 600;
		}
		.log .step:first-child {
			margin-top: 0;
		}
		.note {
			display: grid;
			place-items: center;
			flex: 1;
		}
		.foot {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
		}
	`,
})
export class NewProjectComponent {
	@Service(BackendService) private readonly _backend!: BackendService;
	@Service(RepoStore) private readonly _repos!: RepoStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;
	elementRef!: HTMLElement;

	templates: ProjectTemplate[] = [];
	picked = '';
	name = '';
	parent = '';
	values: Record<string, string> = {};
	state: 'idle' | 'running' | 'done' = 'idle';
	log: ProjectOutput[] = [];
	error = '';
	private _unlisten: (() => void) | null = null;

	get current(): ProjectTemplate | null {
		return this.templates.find((t) => t.id === this.picked) ?? null;
	}

	get target(): string {
		return this.parent.trim() && this.name.trim() ? joinPath(this.parent.trim(), this.name.trim()) : '';
	}

	get canCreate(): boolean {
		const t = this.current;
		return this.state === 'idle' && !!t && !!this.name.trim() && !!this.parent.trim() && t.tools.every((x) => x.found);
	}

	async opened(): Promise<void> {
		this.state = 'idle';
		this.log = [];
		this.error = '';
		this.name = '';
		const repo = this._repos.repo();
		this.parent = saved(PARENT_KEY) || (repo ? dirName(repo.path) : '');
		try {
			this.templates = await this._backend.projectTemplates();
		} catch (e) {
			this.error = asAppError(e).message;
			return;
		}
		this.pick(this.templates.some((t) => t.id === saved(TEMPLATE_KEY)) ? saved(TEMPLATE_KEY) : (this.templates[0]?.id ?? ''));
		requestAnimationFrame(() => this.elementRef.shadowRoot?.querySelector('ml-input')?.shadowRoot?.querySelector('input')?.focus());
	}

	pick(id: string): void {
		this.picked = id;
		this.error = '';
		const t = this.current;
		const values: Record<string, string> = {};
		for (const o of t?.options ?? []) {
			values[o.id] = o.kind === 'flag' ? String(o.default) : o.kind === 'pick' ? o.choices[0].value : o.default;
		}
		this.values = values;
	}

	setValue(id: string, value: string): void {
		this.values = { ...this.values, [id]: value };
	}

	async browse(): Promise<void> {
		const picked = await this._repos.pickFolder();
		if (picked) {
			this.parent = picked;
		}
	}

	openPage(url: string): void {
		void this._backend.openUrl(url).catch((e) => this._repos.fail(e));
	}

	async recheck(): Promise<void> {
		try {
			this.templates = await this._backend.projectTemplates();
		} catch (e) {
			this.error = asAppError(e).message;
		}
	}

	async create(): Promise<void> {
		const t = this.current;
		if (!t || !this.canCreate) {
			return;
		}
		this.state = 'running';
		this.error = '';
		this.log = [];
		keep(PARENT_KEY, this.parent.trim());
		keep(TEMPLATE_KEY, t.id);
		this._unlisten = await this._backend.listen<ProjectOutput>('project-output', (line) => {
			this.log = [...this.log.slice(-400), line];
			requestAnimationFrame(() => {
				const box = this.elementRef.shadowRoot?.querySelector('.log');
				box?.scrollTo({ top: box.scrollHeight });
			});
		});
		try {
			const path = await this._backend.projectCreate(t.id, this.parent.trim(), this.name.trim(), this.values);
			this.state = 'done';
			this.close();
			await Injector.get(InitService).open(path, true);
		} catch (e) {
			this.state = 'idle';
			const message = asAppError(e).message;
			this.error = message === 'Stopped' ? 'Stopped. Anything the tool had already made is still in the folder.' : message;
		} finally {
			this._unlisten?.();
			this._unlisten = null;
		}
	}

	async stop(): Promise<void> {
		await this._backend.projectStop().catch(() => undefined);
	}

	close(): void {
		if (this.state === 'running') {
			return;
		}
		this._dialogs.close('new-project' as DialogId);
	}
}

function option(self: NewProjectComponent, o: TemplateOption, locked: boolean) {
	const v = self.values[o.id] ?? '';
	if (o.kind === 'flag') {
		return html`<ml-checkbox label=${o.label} ?disabled=${locked} .checked=${v === 'true'} @ml:change=${(e: CustomEvent) => self.setValue(o.id, String(e.detail.checked))}></ml-checkbox>`;
	}
	if (o.kind === 'pick') {
		return html`<ml-select label=${o.label} ?disabled=${locked} .options=${o.choices} .value=${v} @ml:change=${(e: CustomEvent) => self.setValue(o.id, e.detail.value)}></ml-select>`;
	}
	if (o.when && self.values[o.when] !== 'true') {
		return '';
	}
	return html`<ml-input label=${o.label} ?disabled=${locked} .value=${v} @ml:input=${(e: CustomEvent) => self.setValue(o.id, e.detail.value)}></ml-input>`;
}

function form(self: NewProjectComponent, t: ProjectTemplate, locked: boolean) {
	const missing = t.tools.filter((x) => !x.found).filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i);
	return html`
		<p><b>${t.name}</b>: ${t.description}</p>
		${missing.length
			? html`
				<div class="needs">
					${missing.map((m) => html`<span>Needs ${m.name}. <a @click=${() => self.openPage(m.installPage)}>Install page</a></span>`)}
					<span>Nothing is installed for you. <a @click=${() => void self.recheck()}>Check again</a> once it is installed.</span>
				</div>
			`
			: ''}
		<ml-input label="Name" placeholder="my-app" hint=${`Use ${t.nameRule}.`} ?disabled=${locked} .value=${self.name} @ml:input=${(e: CustomEvent) => (self.name = e.detail.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && void self.create()}></ml-input>
		<div class="pathrow">
			<ml-input label="Create in" ?disabled=${locked} .value=${self.parent} @ml:input=${(e: CustomEvent) => (self.parent = e.detail.value)}></ml-input>
			<ml-button variant="outline" ?disabled=${locked} @ml:click=${() => void self.browse()}>Choose…</ml-button>
		</div>
		${self.target ? html`<div class="where">${self.target}</div>` : ''}
		${t.options.map((o) => option(self, o, locked))}
		<small>Afterwards the setup wizard creates the git repository and, if you like, the repository on GitHub, Azure DevOps, GitLab or Bitbucket.</small>
	`;
}
