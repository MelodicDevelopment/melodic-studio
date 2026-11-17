/**
 * Paths, the same way on macOS, Windows and Linux. Two kinds reach the window:
 *
 * - Repository-relative paths (`src/app/main.ts`): always `/` separated, exactly as
 *   git prints them. Plain string operations on `/` are fine for these.
 * - Absolute paths (a repository, a worktree, a language server's root): spelled the
 *   way the platform spells them, so `C:\Users\me\repo` on Windows. Never take these
 *   apart or compare them by hand; use the functions here.
 *
 * Nothing in this file imports anything, so it also runs under `node --test`.
 */

/** `C:\…`, `C:/…` or a `\\server\share` path: one where `\` separates folders. */
export function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Index of the last separator, or -1. `\` only counts in a Windows path; elsewhere it is an ordinary character. */
function lastSeparator(path: string): number {
	const slash = path.lastIndexOf('/');
	return isWindowsPath(path) ? Math.max(slash, path.lastIndexOf('\\')) : slash;
}

/** The last segment of a relative or absolute path. */
export function fileName(path: string): string {
	const i = lastSeparator(path);
	return i < 0 ? path : path.slice(i + 1);
}

/** Everything up to and including the last separator; empty for a bare name. */
export function dirName(path: string): string {
	const i = lastSeparator(path);
	return i < 0 ? '' : path.slice(0, i + 1);
}

/** An absolute path with `/` separators and no trailing one. */
function normal(path: string): string {
	const slashed = isWindowsPath(path) ? path.replace(/\\/g, '/') : path;
	return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/**
 * A form of an absolute path that is equal for every spelling of it. On Windows that
 * means lower case as well: names are case-insensitive there, and tools disagree
 * about `C:` or `c:`.
 */
function comparable(path: string): string {
	return isWindowsPath(path) ? normal(path).toLowerCase() : normal(path);
}

/** Whether two absolute paths are the same folder or file, however each is spelled. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	return !!a && !!b && comparable(a) === comparable(b);
}

/**
 * `path` relative to the folder `root`, `/` separated, or null when it is not inside it.
 * The root itself gives `''`.
 */
export function relativeTo(root: string, path: string): string | null {
	const base = comparable(root);
	const full = comparable(path);
	if (full === base) {
		return '';
	}
	const prefix = base.endsWith('/') ? base : `${base}/`;
	if (!full.startsWith(prefix)) {
		return null;
	}
	// Cut from the path itself rather than its lower-cased form, so the case of its names survives.
	return normal(path).slice(prefix.length);
}

/** An absolute path for a repository-relative one, using the separator `root` already uses. */
export function joinPath(root: string, relative: string): string {
	if (!relative) {
		return root;
	}
	const windows = isWindowsPath(root) && !root.includes('/');
	const separator = windows ? '\\' : '/';
	const base = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root;
	return `${base}${separator}${windows ? relative.replace(/\//g, '\\') : relative}`;
}
