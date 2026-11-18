import { html } from '@melodicdev/core/template';
import { HOSTS, type InitRepoComponent } from './init-repo.component';
import { plural } from '../../shared/format';

function setup(self: InitRepoComponent) {
	const info = self.info!;
	return html`
		<p>
			<b>${info.path}</b> ${!info.exists ? 'does not exist yet and will be created.' : info.entries ? `is not a git repository yet. It holds ${plural(info.entries, 'item')}.` : 'is empty.'}
		</p>
		<ml-input label="Default branch" .value=${self.branch} @ml:input=${(e: CustomEvent) => (self.branch = e.detail.value.replace(/\s+/g, '-'))}></ml-input>

		<div class="field">
			<span class="label">Ignore (.gitignore)</span>
			<div class="chips">
				${info.templates.map(
					([id, label]) => html`<ml-checkbox size="sm" label=${label} .checked=${self.templates.includes(id)} @ml:change=${(e: CustomEvent) => self.toggleTemplate(id, e.detail.checked)}></ml-checkbox>`
				)}
			</div>
			${info.hasGitignore ? html`<span class="hint">Added to the .gitignore that is already there.</span>` : ''}
		</div>

		${info.hasReadme ? '' : html`<ml-checkbox label="Add a README" .checked=${self.readme} @ml:change=${(e: CustomEvent) => (self.readme = e.detail.checked)}></ml-checkbox>`}
		<ml-checkbox
			label=${info.entries ? 'Commit what is in the folder now' : 'Make a first commit'}
			hint="Ignored files are left out."
			.checked=${self.commit}
			@ml:change=${(e: CustomEvent) => (self.commit = e.detail.checked)}
		></ml-checkbox>
		${self.commit ? html`<ml-input label="Commit message" .value=${self.message} @ml:input=${(e: CustomEvent) => (self.message = e.detail.value)}></ml-input>` : ''}
		${self.needsIdentity
			? html`
				<p class="warn"><ml-icon icon="info" size="sm"></ml-icon><span>Git does not know who you are yet. This name and email go on your commits in this repository.</span></p>
				<div class="pair">
					<ml-input label="Your name" .value=${self.authorName} @ml:input=${(e: CustomEvent) => (self.authorName = e.detail.value)}></ml-input>
					<ml-input label="Email" type="email" .value=${self.authorEmail} @ml:input=${(e: CustomEvent) => (self.authorEmail = e.detail.value)}></ml-input>
				</div>
			`
			: ''}
	`;
}

function remote(self: InitRepoComponent) {
	const host = HOSTS.find((h) => h.id === self.where)!;
	const cli = self.cli;
	return html`
		<p>The repository is ready on this computer. Where else should it live?</p>
		<div class="hosts">
			${HOSTS.map(
				(h) => html`<button class="host ${h.id === self.where ? 'on' : ''}" @click=${() => self.pick(h.id)}><ml-icon icon=${h.icon} size="md"></ml-icon><span>${h.label}</span></button>`
			)}
		</div>

		${self.where === 'local'
			? html`<p class="hint">Nothing leaves this computer. You can publish it later from the toolbar.</p>`
			: self.usable
				? html`
					<p class="hint">Signed in to ${host.label}${cli?.account ? html` as <b>${cli.account}</b>` : ''} through <code>${cli?.cli}</code>. Melodic Studio creates the repository, sets it as <b>origin</b> and pushes.</p>
					${self.where === 'azure'
						? html`
							<div class="pair end">
								<ml-input label="Organization" placeholder="https://dev.azure.com/your-org" .value=${self.org} @ml:input=${(e: CustomEvent) => (self.org = e.detail.value)}></ml-input>
								<ml-button variant="outline" ?disabled=${!self.org.trim()} @ml:click=${() => self.loadOwners()}>Find projects</ml-button>
							</div>
						`
						: ''}
					${self.owners.length
						? html`<ml-select
								label=${self.where === 'azure' ? 'Project' : 'Owner'}
								.options=${self.owners.map((o) => ({ value: o.id, label: o.label }))}
								.value=${self.owner}
								@ml:change=${(e: CustomEvent) => (self.owner = e.detail.value)}
							></ml-select>`
						: ''}
					<ml-input label="Repository name" .value=${self.repoName} @ml:input=${(e: CustomEvent) => (self.repoName = e.detail.value.replace(/\s+/g, '-'))}></ml-input>
					${self.where === 'azure' ? '' : html`<ml-checkbox label="Private" hint="Only you and people you invite can see it." .checked=${self.isPrivate} @ml:change=${(e: CustomEvent) => (self.isPrivate = e.detail.checked)}></ml-checkbox>`}
				`
				: html`
					${cli?.hint ? html`<p class="warn"><ml-icon icon="info" size="sm"></ml-icon><span>To create it from here: ${cli.hint} Until then, create it on ${host.label} and paste its URL.</span></p>` : ''}
					${host.createPage
						? html`<ml-button variant="outline" @ml:click=${() => self.openCreatePage(host.createPage!)}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>Create it on ${host.label}</ml-button>`
						: html`<p class="hint">Create an empty repository on your git host, then paste its URL.</p>`}
					<ml-input label="Repository URL" placeholder="git@host:owner/repo.git or https://…" .value=${self.url} @ml:input=${(e: CustomEvent) => (self.url = e.detail.value)}></ml-input>
				`}
		${self.error ? html`<p class="warn bad"><ml-icon icon="warning" size="sm"></ml-icon><span>${self.error}</span></p>` : ''}
	`;
}

export function initRepoTemplate(self: InitRepoComponent) {
	const info = self.info;
	return html`
		<ml-dialog #init-repo style="--ml-dialog-max-width: 560px" @ml:open=${(e: Event) => e.target === e.currentTarget && self.opened()}>
			<h3 slot="dialog-header">${self.step === 'setup' ? 'Set up a repository' : 'Where should it live?'}</h3>
			<div class="dlg">${!info ? '' : self.step === 'setup' ? setup(self) : remote(self)}</div>
			<div slot="dialog-footer" class="foot">
				${self.step === 'setup'
					? html`
						<ml-button variant="outline" @ml:click=${() => self.close()}>Cancel</ml-button>
						<ml-button
							variant="primary"
							?disabled=${!self.branch.trim() || (self.needsIdentity && !(self.authorName.trim() && self.authorEmail.trim()))}
							?loading=${self.busy}
							@ml:click=${() => self.initialize()}
							>Create repository</ml-button
						>
					`
					: html`
						<ml-button variant="outline" ?disabled=${self.busy} @ml:click=${() => self.close()}>${self.where === 'local' ? 'Close' : 'Skip for now'}</ml-button>
						${self.where === 'local'
							? ''
							: html`<ml-button variant="primary" ?disabled=${!self.canFinish} ?loading=${self.busy} @ml:click=${() => self.finish()}>${self.usable ? 'Create and push' : 'Add remote and push'}</ml-button>`}
					`}
			</div>
		</ml-dialog>
	`;
}
