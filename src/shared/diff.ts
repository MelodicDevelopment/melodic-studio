/** Unified-diff text from git, parsed into rows the diff view can render. */

export interface DiffLine {
	kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note';
	oldNo: number | null;
	newNo: number | null;
	text: string;
}

export interface ParsedDiff {
	lines: DiffLine[];
	binary: boolean;
	tooLarge: boolean;
	/** More lines exist than are rendered. */
	truncated: boolean;
	added: number;
	removed: number;
	/** The raw text, to skip re-rendering when a refresh returns the same diff. */
	raw: string;
}

const MAX_LINES = 6000;

export function parseDiff(raw: string, tooLarge = false): ParsedDiff {
	const out: ParsedDiff = { lines: [], binary: false, tooLarge, truncated: false, added: 0, removed: 0, raw };
	if (tooLarge || !raw) {
		return out;
	}
	let inHunk = false;
	let combined = false;
	let oldNo = 0;
	let newNo = 0;
	const rows = raw.split('\n');
	if (rows[rows.length - 1] === '') {
		rows.pop();
	}
	for (const row of rows) {
		if (row.startsWith('diff --')) {
			inHunk = false;
			continue;
		}
		if (row.startsWith('@@')) {
			combined = row.startsWith('@@@');
			const m = /^@@+ -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )*\+(\d+)(?:,\d+)? @@+/.exec(row);
			oldNo = m ? Number(m[1]) : 0;
			newNo = m ? Number(m[2]) : 0;
			inHunk = true;
			out.lines.push({ kind: 'hunk', oldNo: null, newNo: null, text: row });
			continue;
		}
		if (!inHunk) {
			if (row.startsWith('Binary files ') || row.startsWith('GIT binary patch')) {
				out.binary = true;
			}
			continue;
		}
		if (out.lines.length >= MAX_LINES) {
			out.truncated = true;
			break;
		}
		if (row.startsWith('\\')) {
			out.lines.push({ kind: 'note', oldNo: null, newNo: null, text: row.slice(2) });
			continue;
		}
		const width = combined ? 2 : 1;
		const marks = row.slice(0, width);
		const text = row.slice(width);
		if (marks.includes('+')) {
			out.added++;
			out.lines.push({ kind: 'add', oldNo: null, newNo: combined ? null : newNo++, text });
		} else if (marks.includes('-')) {
			out.removed++;
			out.lines.push({ kind: 'del', oldNo: combined ? null : oldNo++, newNo: null, text });
		} else {
			out.lines.push({ kind: 'ctx', oldNo: combined ? null : oldNo++, newNo: combined ? null : newNo++, text });
		}
	}
	return out;
}
