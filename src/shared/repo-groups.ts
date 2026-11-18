/**
 * Grouping repositories by where their origin lives (GitHub, Azure DevOps, ...) and then by
 * owner (GitHub owner, Azure DevOps org/project, GitLab group, Bitbucket workspace).
 * Used by the repository dropdown and the scan results. No imports, so `npm test` runs it as is.
 */

export interface RepoOrigin {
	/** github | azure | gitlab | bitbucket | other */
	provider: string;
	/** "GitHub", "Azure DevOps", ... or the host name. */
	label: string;
	/** Empty when the URL names no owner. */
	owner: string;
}

export interface OwnerGroup<T> {
	/** Unique across all groups, for remembering what is collapsed. */
	key: string;
	owner: string;
	items: T[];
}

export interface HostGroup<T> {
	key: string;
	provider: string;
	label: string;
	owners: OwnerGroup<T>[];
	count: number;
}

const ORDER = ['github', 'azure', 'gitlab', 'bitbucket', 'other', 'local'];
const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

export function groupByOrigin<T extends { name: string; origin?: RepoOrigin | null }>(items: T[]): HostGroup<T>[] {
	const hosts = new Map<string, { provider: string; label: string; owners: Map<string, T[]> }>();
	for (const item of items) {
		const o = item.origin;
		const provider = o?.provider ?? 'local';
		const label = o ? o.label : 'No remote';
		// Every self-hosted server of the "other" kind is its own group.
		const key = provider === 'other' ? `other:${label.toLowerCase()}` : provider;
		let host = hosts.get(key);
		if (!host) {
			host = { provider, label, owners: new Map() };
			hosts.set(key, host);
		}
		const owner = o?.owner ?? '';
		const list = host.owners.get(owner.toLowerCase());
		if (list) {
			list.push(item);
		} else {
			host.owners.set(owner.toLowerCase(), [item]);
		}
	}
	return [...hosts.entries()]
		.map(([key, h]) => {
			const owners = [...h.owners.values()]
				.map((list) => ({ key: `${key}/${(list[0].origin?.owner ?? '').toLowerCase()}`, owner: list[0].origin?.owner ?? '', items: [...list].sort((a, b) => byText(a.name, b.name)) }))
				// Repositories with no owner first, then owners alphabetically.
				.sort((a, b) => (a.owner === '' ? -1 : b.owner === '' ? 1 : byText(a.owner, b.owner)));
			return { key, provider: h.provider, label: h.label, owners, count: owners.reduce((n, g) => n + g.items.length, 0) };
		})
		.sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider) || byText(a.label, b.label));
}

/** The icon the app uses for a host. */
export function hostIcon(provider: string): string {
	return provider === 'github' ? 'github-logo' : provider === 'gitlab' ? 'gitlab-logo' : provider === 'azure' ? 'windows-logo' : provider === 'local' ? 'hard-drives' : 'globe';
}
