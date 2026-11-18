/**
 * What each host's command-line tool unlocks and how to get it on this OS. The app never installs
 * anything itself; these are the lines the user copies or has typed into a terminal.
 */
import { isMac, isWindows } from '../services/backend.service';

export interface ToolGuide {
	provider: 'github' | 'azure' | 'gitlab' | 'jira';
	tool: string;
	name: string;
	unlocks: string;
	/** For this OS; null where the vendor's page is the only sensible instruction. */
	install: string | null;
	installPage: string;
	/** Further setup after installing (az's extension). */
	extra: string | null;
	signIn: string;
}

export function toolGuide(provider: string): ToolGuide | null {
	const mac = isMac();
	const win = isWindows();
	switch (provider) {
		case 'github':
			return {
				provider,
				tool: 'gh',
				name: 'GitHub CLI',
				unlocks: 'Issues, pull requests (browse, review, merge, check out), Actions runs and new repositories on GitHub.',
				install: mac ? 'brew install gh' : win ? 'winget install --id GitHub.cli' : null,
				installPage: 'https://cli.github.com',
				extra: null,
				signIn: 'gh auth login',
			};
		case 'azure':
			return {
				provider,
				tool: 'az',
				name: 'Azure CLI with the azure-devops extension',
				unlocks: 'Work items, pull requests (browse, vote, complete), pipeline runs and new repositories on Azure DevOps.',
				install: mac ? 'brew install azure-cli' : win ? 'winget install --id Microsoft.AzureCLI' : null,
				installPage: 'https://aka.ms/installazurecli',
				extra: 'az extension add --name azure-devops',
				signIn: 'az login',
			};
		case 'gitlab':
			return {
				provider,
				tool: 'glab',
				name: 'GitLab CLI',
				unlocks: 'Issues, merge requests (browse, approve, merge, check out), pipelines and new projects on GitLab.',
				install: mac ? 'brew install glab' : win ? 'winget install --id GLab.GLab' : null,
				installPage: 'https://gitlab.com/gitlab-org/cli#installation',
				extra: null,
				signIn: 'glab auth login',
			};
		case 'jira':
			return {
				provider,
				tool: 'acli',
				name: 'Atlassian CLI',
				unlocks: 'Your Jira issues: search, move between statuses, comment, and a branch named after the issue.',
				install: mac ? 'brew tap atlassian/homebrew-acli && brew install acli' : null,
				installPage: 'https://developer.atlassian.com/cloud/acli/guides/install-acli/',
				extra: null,
				signIn: 'acli jira auth login --web',
			};
		default:
			return null;
	}
}
