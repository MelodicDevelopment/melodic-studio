import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { HostStore } from '../../services/host.store';
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

	onCreate(): void {
		this.host.watch();
	}

	/** Git branch names cannot hold spaces; turn them into dashes as the other branch fields do. */
	setBranch(value: string): void {
		this.host.editTask({ branch: value.replace(/\s+/g, '-') });
	}

	/** The fallback when the host's tool cannot be used: its own page in the browser. */
	openIssuesPage(): void {
		void this.repos.openIn('issues');
	}
}
