/** Jira keys and branch names; no app services, so the tests run it directly. */
import type { JiraIssue } from '../services/backend.service';

/** "ABC-12 Fix the login" → `ABC-12-fix-the-login`, the branch name Jira's own integrations look for. */
export function jiraBranch(issue: Pick<JiraIssue, 'key' | 'title'>): string {
	const slug = issue.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean)
		.slice(0, 6)
		.join('-')
		.slice(0, 40)
		.replace(/-+$/, '');
	return slug ? `${issue.key}-${slug}` : issue.key;
}

/** The Jira key a branch name carries (`feature/ABC-12-login` → `ABC-12`), for the commit message. */
export function jiraKeyOf(branch: string): string | null {
	return /(?:^|[/_-])([A-Z][A-Z0-9_]{1,29}-\d{1,9})(?=$|[/_-])/.exec(branch)?.[1] ?? null;
}
