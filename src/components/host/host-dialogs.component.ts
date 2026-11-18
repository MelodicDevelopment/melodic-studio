import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { HostStore, issueBranch } from '../../services/host.store';
import { HostWorkStore } from '../../services/host-work.store';
import type { HostIssue } from '../../services/backend.service';
import { RepoStore } from '../../services/repo.store';
import { AgentsStore } from '../../services/agents.store';
import { hostDialogsTemplate } from './host-dialogs.template';
import { hostDialogsStyles } from './host-dialogs.styles';

/**
 * The two dialogs that bring the repository's host into the app: issues / work
 * items (with "Start agent on this") and the pull request Claude drafts. Both are
 * opened through `HostStore` (`openIssues()`, `openPr()`); the state lives there.
 */
@MelodicComponent({
	selector: 'ms-host-dialogs',
	template: hostDialogsTemplate,
	styles: hostDialogsStyles,
})
export class HostDialogsComponent {
	@Service(HostStore) readonly host!: HostStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(HostWorkStore) readonly work!: HostWorkStore;

	onCreate(): void {
		this.host.watch();
	}

	/** Git branch names cannot hold spaces; turn them into dashes as the other branch fields do. */
	setBranch(value: string): void {
		this.host.editTask({ branch: value.replace(/\s+/g, '-') });
	}

	selectIssue(id: string): void {
		if (id !== this.host.selectedIssueId()) {
			this.work.issueComment.set('');
			this.work.newIssue.set(null);
		}
		this.host.selectIssue(id);
	}

	/** A branch named after the issue, made from the current commit and checked out. */
	async branchFor(issue: HostIssue): Promise<void> {
		this.host.close('host-issues');
		await this.work.branchFor(issueBranch(issue));
	}

	/** The fallback when the host's tool cannot be used: its own page in the browser. */
	openIssuesPage(): void {
		void this.repos.openIn('issues');
	}
}
