/**
 * The little path handling the agent features need, kept in one place because
 * checkout paths come from the backend in the operating system's own spelling
 * (`C:\Users\me\proj` on Windows) while paths inside a repository are always
 * `/` separated.
 */

/** A path with `/` separators and no trailing one, for comparing and for prefix checks. */
export function slashed(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Do two checkout paths name the same folder? Windows spells drive letters and separators loosely. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) {
		return false;
	}
	const x = slashed(a);
	const y = slashed(b);
	return x === y || (/^[A-Za-z]:\//.test(x) && x.toLowerCase() === y.toLowerCase());
}

/** The last segment of a checkout path: the folder's name. */
export function baseName(path: string): string {
	const p = slashed(path);
	return p.slice(p.lastIndexOf('/') + 1);
}

/**
 * A path a model wrote, as a repository-relative `/` path: `./src/a.ts`, `src\a.ts` and
 * `<checkout>/src/a.ts` all become `src/a.ts`. Null for anything that points outside the checkout.
 */
export function repoRelative(path: string, checkout: string | null): string | null {
	let p = path.replace(/\\/g, '/');
	const root = checkout ? slashed(checkout) : '';
	if (root && p.length > root.length && samePath(p.slice(0, root.length), root) && p[root.length] === '/') {
		p = p.slice(root.length + 1);
	}
	p = p.replace(/^(\.\/)+/, '');
	if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
		return null;
	}
	return p;
}
