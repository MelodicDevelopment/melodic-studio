/**
 * Find in files, the part with no window in it: the shapes the native side answers with
 * (`Git::grep` in git.rs), the search as a JavaScript expression for marking matches in a
 * line git found, and the grouping by file. `searchIn` is the browser preview's search.
 */

/** The native side sends no more matching lines than this (`SEARCH_LIMIT` in commands.rs). */
export const SEARCH_LIMIT = 2000;

export interface SearchOptions {
	matchCase: boolean;
	wholeWord: boolean;
	/** The text is a regular expression rather than itself. */
	regex: boolean;
}

/** One matching line. `column` counts from 1 as the editor does; `start` is where the first match begins in `text`. */
export interface SearchMatch {
	path: string;
	line: number;
	column: number;
	/** The line without its leading white space, cut around the match when it is long. */
	text: string;
	start: number;
}

export interface SearchResult {
	matches: SearchMatch[];
	/** There were more matching lines than are listed. */
	truncated: boolean;
}

export interface FileHits {
	path: string;
	name: string;
	/** The folder, with its trailing slash; empty at the root. */
	dir: string;
	matches: SearchMatch[];
}

/**
 * The search as JavaScript reads it. git did the finding (POSIX extended expressions); this only
 * marks the matches in a line, so where the two dialects differ (`[[:alpha:]]`) or the
 * expression does not compile, the answer is null and the line is shown unmarked.
 */
export function matcher(query: string, options: SearchOptions): RegExp | null {
	if (!query) {
		return null;
	}
	let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (options.wholeWord) {
		source = `(?<!\\w)(?:${source})(?!\\w)`;
	}
	try {
		return new RegExp(source, options.matchCase ? 'g' : 'gi');
	} catch {
		return null;
	}
}

/** The stretches of `text` to mark, as [from, to). */
export function marks(text: string, re: RegExp | null): [number, number][] {
	const out: [number, number][] = [];
	if (!re) {
		return out;
	}
	re.lastIndex = 0;
	for (let m = re.exec(text); m && out.length < 40; m = re.exec(text)) {
		if (m[0].length) {
			out.push([m.index, m.index + m[0].length]);
		} else {
			re.lastIndex++; // an expression that matches nothing would stay where it is
		}
	}
	return out;
}

/** `text` in pieces, the marked ones flagged, for a template to print as text. */
export function pieces(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
	const out: { text: string; hit: boolean }[] = [];
	let at = 0;
	for (const [from, to] of ranges) {
		if (from > at) {
			out.push({ text: text.slice(at, from), hit: false });
		}
		out.push({ text: text.slice(from, to), hit: true });
		at = to;
	}
	if (at < text.length) {
		out.push({ text: text.slice(at), hit: false });
	}
	return out;
}

/** Matches arrive file by file; this keeps that order. */
export function byFile(matches: SearchMatch[]): FileHits[] {
	const files = new Map<string, FileHits>();
	for (const m of matches) {
		let file = files.get(m.path);
		if (!file) {
			const cut = m.path.lastIndexOf('/') + 1;
			file = { path: m.path, name: m.path.slice(cut), dir: m.path.slice(0, cut), matches: [] };
			files.set(m.path, file);
		}
		file.matches.push(m);
	}
	return [...files.values()];
}

/** "1,204 results in 37 files". */
export function summary(result: SearchResult, limit: number): string {
	const files = new Set(result.matches.map((m) => m.path)).size;
	const n = result.matches.length;
	if (!n) {
		return 'No results. Files that .gitignore leaves out and binary files are not searched.';
	}
	const count = `${n.toLocaleString('en-US')} result${n === 1 ? '' : 's'} in ${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'}`;
	return result.truncated ? `The first ${limit.toLocaleString('en-US')} results (${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'}). There are more: narrow the search to see them.` : count;
}

/** The browser preview's search: the same answer shape, from texts held in memory. */
export function searchIn(files: Iterable<[string, string]>, query: string, options: SearchOptions, limit: number): SearchResult {
	const result: SearchResult = { matches: [], truncated: false };
	if (!query) {
		return result;
	}
	const re = matcher(query, options);
	if (!re) {
		throw { kind: 'git', message: `"${query}" is not a regular expression` };
	}
	for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const [first] = marks(lines[i], re);
			if (!first) {
				continue;
			}
			if (result.matches.length === limit) {
				result.truncated = true;
				return result;
			}
			const shown = lines[i].trimStart();
			result.matches.push({ path, line: i + 1, column: first[0] + 1, text: shown.trimEnd(), start: first[0] - (lines[i].length - shown.length) });
		}
	}
	return result;
}
