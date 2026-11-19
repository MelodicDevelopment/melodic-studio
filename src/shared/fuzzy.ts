/**
 * Opening a file by name: what was typed against every path of a checkout.
 * The letters must appear in order; where they land decides the rank (the start of the file
 * name, the start of a word, letters next to each other), and a match inside the file name
 * beats the same letters spread over the folders. The scoring is fzy's.
 */

/** A checkout's files, prepared once so each keystroke only compares. */
export interface FileIndex {
	paths: string[];
	lower: string[];
	/** Where each path's file name starts. */
	nameAt: Int32Array;
}

export interface Ranked {
	path: string;
	score: number;
	/** The positions in `path` of the letters that matched, for marking them. */
	at: number[];
}

/** What the "Go to" box was asked for. */
export interface GoTo {
	mode: 'files' | 'symbols';
	query: string;
	/** `name:12` or `name:12:4` opens the file there. */
	line: number | null;
	column: number | null;
}

const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const CONSECUTIVE = 1.0;
const AFTER_SLASH = 0.9;
const AFTER_WORD = 0.8;
const CAPITAL = 0.7;
const AFTER_DOT = 0.6;
/** Everything typed was found in the file name itself. */
const IN_NAME = 2;
const EXACT_NAME = 1;
const NONE = -Infinity;

export function buildIndex(paths: string[]): FileIndex {
	const nameAt = new Int32Array(paths.length);
	const lower = new Array<string>(paths.length);
	for (let i = 0; i < paths.length; i++) {
		nameAt[i] = paths[i].lastIndexOf('/') + 1;
		lower[i] = paths[i].toLowerCase();
	}
	return { paths, lower, nameAt };
}

/** `@name` looks for a symbol; anything else is a file, perhaps with `:line` or `:line:column` after it. */
export function parseGoTo(text: string): GoTo {
	if (text.startsWith('@')) {
		return { mode: 'symbols', query: text.slice(1).trim(), line: null, column: null };
	}
	const at = /^(.*?):(\d+)(?::(\d+))?:?$/.exec(text.trim());
	return at ? { mode: 'files', query: at[1].trim(), line: Number(at[2]), column: at[3] ? Number(at[3]) : null } : { mode: 'files', query: text.trim(), line: null, column: null };
}

function bonusAt(text: string, i: number): number {
	if (i === 0) {
		return AFTER_SLASH;
	}
	const prev = text[i - 1];
	if (prev === '/') {
		return AFTER_SLASH;
	}
	if (prev === '-' || prev === '_' || prev === ' ') {
		return AFTER_WORD;
	}
	if (prev === '.') {
		return AFTER_DOT;
	}
	const ch = text[i];
	return ch >= 'A' && ch <= 'Z' && prev >= 'a' && prev <= 'z' ? CAPITAL : 0;
}

function isSubsequence(needle: string, hay: string, from: number): boolean {
	let at = from;
	for (let i = 0; i < needle.length; i++) {
		at = hay.indexOf(needle[i], at);
		if (at < 0) {
			return false;
		}
		at++;
	}
	return true;
}

/**
 * The best way to find `needle` (lower case) in `text` from `from` on: its score, and with `positions`
 * where each letter landed. null when the letters are not there in order.
 */
export function fuzzyMatch(needle: string, text: string, lower: string, from = 0, positions = false): { score: number; at: number[] } | null {
	const n = needle.length;
	const m = lower.length - from;
	if (!n || n > m || !isSubsequence(needle, lower, from)) {
		return null;
	}
	if (n === m) {
		return { score: 1000, at: positions ? Array.from({ length: n }, (_, i) => from + i) : [] };
	}
	// D: the best score with needle[i] landing exactly at j. M: the best score for needle[..i] anywhere up to j.
	const D = new Float64Array(n * m);
	const M = new Float64Array(n * m);
	for (let i = 0; i < n; i++) {
		let prev = NONE;
		const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
		const ch = needle[i];
		for (let j = 0; j < m; j++) {
			const k = i * m + j;
			if (lower[from + j] === ch) {
				let score = NONE;
				if (i === 0) {
					score = j * GAP_LEADING + bonusAt(text, from + j);
				} else if (j > 0) {
					const up = (i - 1) * m + j - 1;
					score = Math.max(M[up] + bonusAt(text, from + j), D[up] + CONSECUTIVE);
				}
				D[k] = score;
				prev = Math.max(score, prev + gap);
			} else {
				D[k] = NONE;
				prev = prev + gap;
			}
			M[k] = prev;
		}
	}
	const score = M[n * m - 1];
	if (score === NONE) {
		return null;
	}
	const at: number[] = [];
	if (positions) {
		// Walk back: a letter is where D gave the score M carries; after a consecutive pair the one before it is forced.
		let forced = false;
		for (let i = n - 1, j = m - 1; i >= 0; i--) {
			for (; j >= 0; j--) {
				const k = i * m + j;
				if (D[k] !== NONE && (forced || D[k] === M[k])) {
					forced = i > 0 && j > 0 && M[k] === D[(i - 1) * m + j - 1] + CONSECUTIVE;
					at.unshift(from + j--);
					break;
				}
			}
		}
	}
	return { score, at };
}

/** One path against the words typed: every word must be found. */
function scorePath(words: string[], path: string, lower: string, nameAt: number, positions: boolean): { score: number; at: number[] } | null {
	let total = 0;
	const at: number[] = [];
	for (const word of words) {
		const inName = word.includes('/') ? null : fuzzyMatch(word, path, lower, nameAt, positions);
		const inPath = fuzzyMatch(word, path, lower, 0, positions);
		const named = inName ? inName.score + IN_NAME + (word.length === lower.length - nameAt ? EXACT_NAME : 0) : NONE;
		const best = inName && named >= (inPath?.score ?? NONE) ? { score: named, at: inName.at } : inPath;
		if (!best) {
			return null;
		}
		total += best.score;
		at.push(...best.at);
	}
	return { score: total, at };
}

/**
 * The best `limit` files for what was typed. Nothing typed: the recently opened files (most recent
 * first), then the rest as they are listed. A recently opened file wins a tie.
 */
export function rankFiles(index: FileIndex, query: string, recent: string[], limit: number): Ranked[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const recency = new Map(recent.map((path, i) => [path, i]));
	if (!words.length) {
		const known = new Set(index.paths);
		const first = recent.filter((p) => known.has(p)).slice(0, limit);
		const out: Ranked[] = first.map((path) => ({ path, score: 0, at: [] }));
		for (let i = 0; i < index.paths.length && out.length < limit; i++) {
			if (!recency.has(index.paths[i])) {
				out.push({ path: index.paths[i], score: 0, at: [] });
			}
		}
		return out;
	}
	const found: { i: number; score: number }[] = [];
	for (let i = 0; i < index.paths.length; i++) {
		const hit = scorePath(words, index.paths[i], index.lower[i], index.nameAt[i], false);
		if (hit) {
			const seen = recency.get(index.paths[i]);
			// A shorter path wins between equals, and a file opened lately a little more than that.
			found.push({ i, score: hit.score - index.paths[i].length * 0.0005 + (seen === undefined ? 0 : 0.3 - Math.min(seen, 20) * 0.01) });
		}
	}
	found.sort((a, b) => b.score - a.score || a.i - b.i);
	return found.slice(0, limit).map(({ i, score }) => ({ path: index.paths[i], score, at: scorePath(words, index.paths[i], index.lower[i], index.nameAt[i], true)?.at.sort((a, b) => a - b) ?? [] }));
}

/** A path in pieces, the matched letters flagged, for a template to print as text. */
export function marked(text: string, offset: number, at: number[]): { text: string; hit: boolean }[] {
	const hits = new Set(at);
	const out: { text: string; hit: boolean }[] = [];
	for (let i = 0; i < text.length; i++) {
		const hit = hits.has(offset + i);
		const last = out[out.length - 1];
		if (last && last.hit === hit) {
			last.text += text[i];
		} else {
			out.push({ text: text[i], hit });
		}
	}
	return out;
}
