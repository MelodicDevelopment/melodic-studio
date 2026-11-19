/**
 * Replay: turning one recorded run into steps that can be scrubbed through.
 *
 * During an investigation Claude adds one-line recording calls to the functions on the failure's
 * path. Every such line ends with the marker comment `studio-replay`, and each call appends one
 * JSON line to `<worktree>/.studio/replay/run-<n>.jsonl`:
 *
 *   {"event":"line","fn":"PricingService.ApplyDiscount","file":"src/Shop.Pricing/PricingService.cs","line":41,"values":{"tier":"null"}}
 *
 * When the run starts, Studio keeps a copy of every instrumented file. Replay shows each file
 * with its marker lines taken out and maps the recorded line numbers back to that clean text,
 * so the steps and values always match the code the user sees. A recording call sits on the line
 * after the statement it records, so a marker line maps to the nearest line of real code above it;
 * a "return" is recorded just before the function returns, so it maps to the line below instead.
 *
 * A step's number (`seq`) is its position in the file, from 1: several copies of the helper (one
 * per project) could not agree on a counter, and the order they wrote in is the order it ran in.
 * Depth is worked out here from the enter and return events, for the same reason.
 *
 * No imports: this runs under `npm test`. Everything in a recording is untrusted program data.
 */

export const REPLAY_MARKER = 'studio-replay';

export type ReplayEventKind = 'enter' | 'line' | 'return' | 'throw';

export interface ReplayEvent {
	/** Its line in the recording, from 1. */
	seq: number;
	event: ReplayEventKind;
	fn: string;
	/** As the program reported it: absolute, or relative to where it ran. */
	file: string;
	/** The line of the recording call in the instrumented file. */
	line: number;
	values: [name: string, value: string][];
}

export interface ReplayStep {
	seq: number;
	event: ReplayEventKind;
	fn: string;
	/** The copy of the file this step is in (its path in the worktree), or null when no copy matches. */
	file: string | null;
	/** The file's name as recorded, for showing when there is no copy. */
	fileLabel: string;
	/** The line in the clean file (recording lines taken out), from 1; 0 when unknown. */
	line: number;
	/** How deep in the recorded calls, from 0. */
	depth: number;
	values: [name: string, value: string][];
	kind: 'cause' | 'crash' | null;
	note: string | null;
}

export interface ReplayView {
	steps: ReplayStep[];
	/** Each copied file without its recording lines, by worktree path. */
	files: Record<string, string[]>;
	/** Index into `steps`, or -1. */
	cause: number;
	crash: number;
}

export interface SourceLine {
	n: number;
	text: string;
	current: boolean;
	/** What was recorded on this line in the current call, up to the current step. */
	values: string | null;
}

const MAX_EVENTS = 5000;
const MAX_VALUE = 200;
const KINDS: ReplayEventKind[] = ['enter', 'line', 'return', 'throw'];

function isMarker(line: string): boolean {
	return line.includes(REPLAY_MARKER);
}

/** A line that is not a statement: blank, or only a comment. A recording never belongs to one of these. */
function isFiller(line: string): boolean {
	return /^\s*($|\/\/|#|\/\*|\*|--\s)/.test(line);
}

/**
 * A file without its recording lines, and where each of its original lines went: `toClean[i]`
 * is the clean line number (from 1) for original line `i + 1`. A recording line maps to the
 * line of code above it (the statement it records); blank lines, comments and a lone `{` above
 * are skipped, so the first recording line of a function points at its signature. `toNext[i]`
 * is the line of code below a recording line instead (again past blank lines and comments),
 * which is where a "return" belongs.
 */
export function cleanSource(text: string): { lines: string[]; toClean: number[]; toNext: number[] } {
	const original = text.replace(/\r\n/g, '\n').split('\n');
	const lines: string[] = [];
	const toClean: number[] = [];
	const toNext: number[] = [];
	for (const line of original) {
		if (isMarker(line)) {
			let at = lines.length; // the last clean line so far, 1-based
			while (at > 1 && (isFiller(lines[at - 1]) || /^\s*\{\s*$/.test(lines[at - 1]))) {
				at--;
			}
			toClean.push(Math.max(1, at));
			toNext.push(lines.length + 1);
		} else {
			lines.push(line);
			toClean.push(lines.length);
			toNext.push(lines.length);
		}
	}
	// Found only now that the lines below are known: the next line that is a statement.
	const below = (n: number): number => {
		let at = Math.min(n, Math.max(1, lines.length)); // a recording line at the very end has no code below it
		while (at < lines.length && isFiller(lines[at - 1])) {
			at++;
		}
		return at;
	};
	return { lines, toClean, toNext: toNext.map((n, i) => (n === toClean[i] ? n : below(n))) };
}

function short(value: unknown): string {
	const text = typeof value === 'string' ? value : value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value));
	return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** The events of a recording, in the order they were written. Lines that are not an event are skipped, but still count. */
export function parseEvents(text: string): ReplayEvent[] {
	const events: ReplayEvent[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length && events.length < MAX_EVENTS; i++) {
		const raw = lines[i].trim();
		if (!raw.startsWith('{')) {
			continue;
		}
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			continue;
		}
		const event = String(json.event ?? '').toLowerCase() as ReplayEventKind;
		if (!KINDS.includes(event) || typeof json.fn !== 'string') {
			continue;
		}
		const values = json.values && typeof json.values === 'object' && !Array.isArray(json.values) ? Object.entries(json.values as Record<string, unknown>).map<[string, string]>(([k, v]) => [k.slice(0, 80), short(v)]) : [];
		events.push({ seq: i + 1, event, fn: json.fn.slice(0, 200), file: typeof json.file === 'string' ? json.file : '', line: Number(json.line) || 0, values });
	}
	return events;
}

function slashed(path: string): string {
	return path.replace(/\\/g, '/');
}

/** The copied file a recorded path means: the same path, or the copy one of them ends with (programs report absolute paths). */
export function matchFile(recorded: string, copies: string[]): string | null {
	const wanted = slashed(recorded).replace(/^\.\//, '');
	if (!wanted) {
		return null;
	}
	if (copies.includes(wanted)) {
		return wanted;
	}
	const fits = copies.filter((c) => wanted.endsWith(`/${c}`) || c.endsWith(`/${wanted}`));
	// The longest match is the most specific one (`src/a/util.py` over `util.py`).
	return fits.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * How deep each event is, from the enters and returns: an enter goes one deeper after itself,
 * a return or throw comes back up. An event from a function that is not on top of the stack
 * (its enter was not recorded, or a return was missed) puts the stack right first.
 */
export function depths(events: ReplayEvent[]): number[] {
	const stack: string[] = [];
	return events.map((e) => {
		const at = stack.lastIndexOf(e.fn);
		if (e.event === 'enter') {
			stack.push(e.fn);
			return stack.length - 1;
		}
		if (at < 0) {
			stack.push(e.fn);
		} else {
			stack.length = at + 1;
		}
		const depth = stack.length - 1;
		if (e.event === 'return' || e.event === 'throw') {
			stack.pop();
		}
		return depth;
	});
}

export interface ReplayMarks {
	causeSeq: number | null;
	crashSeq: number | null;
	/** Claude's note for a step, by seq. */
	notes: Record<string, string>;
}

/** The steps of a recorded run, with every line number mapped to the clean copy of its file. */
export function buildReplay(recording: string, copies: { path: string; text: string }[], marks: ReplayMarks): ReplayView {
	const events = parseEvents(recording);
	const cleaned = new Map(copies.map((c) => [slashed(c.path), cleanSource(c.text)]));
	const paths = [...cleaned.keys()];
	const depth = depths(events);
	const steps = events.map<ReplayStep>((e, i) => {
		const file = matchFile(e.file, paths);
		const clean = file ? cleaned.get(file)! : null;
		const map = clean ? (e.event === 'return' ? clean.toNext : clean.toClean) : null;
		const line = map && e.line >= 1 && e.line <= map.length ? map[e.line - 1] : clean ? 0 : e.line;
		const note = marks.notes[String(e.seq)];
		return {
			seq: e.seq,
			event: e.event,
			fn: e.fn,
			file,
			fileLabel: slashed(e.file).split('/').pop() ?? '',
			line,
			depth: depth[i],
			values: e.values,
			kind: e.seq === marks.crashSeq ? 'crash' : e.seq === marks.causeSeq ? 'cause' : null,
			note: typeof note === 'string' && note.trim() ? note.trim() : null,
		};
	});
	const files: Record<string, string[]> = {};
	cleaned.forEach((c, path) => (files[path] = c.lines));
	// A throw is where it crashed when Claude did not say; the last step otherwise has no special meaning.
	let crash = steps.findIndex((s) => s.kind === 'crash');
	if (crash < 0) {
		crash = steps.map((s) => s.event).lastIndexOf('throw');
		if (crash >= 0) {
			steps[crash] = { ...steps[crash], kind: steps[crash].kind ?? 'crash' };
		}
	}
	return { steps, files, cause: steps.findIndex((s) => s.kind === 'cause'), crash };
}

/** Where Replay opens: on the cause, else the crash, else the first step. */
export function openingStep(view: ReplayView): number {
	return view.cause >= 0 ? view.cause : view.crash >= 0 ? view.crash : 0;
}

function chip(values: [string, string][]): string {
	return values.map(([name, value]) => `${name} = ${value}`).join(', ');
}

/** The steps of the call the step at `index` belongs to, from its enter (or its first recorded line) up to `index`. */
function sameCall(view: ReplayView, index: number): ReplayStep[] {
	const current = view.steps[index];
	const out: ReplayStep[] = [];
	for (let i = index; i >= 0; i--) {
		const s = view.steps[i];
		if (s.depth < current.depth) {
			break; // back in the caller: this call began after this point
		}
		if (s.depth === current.depth && s.fn === current.fn && s.file === current.file) {
			out.unshift(s);
			if (s.event === 'enter') {
				break;
			}
		} else if (s.depth === current.depth) {
			break; // an earlier, different call at the same depth
		}
	}
	return out;
}

/**
 * The code to show for a step: the lines of its function that were recorded (every step of the
 * same function in the run, so the view does not jump as the run is scrubbed), a little around
 * them, the current line marked, and the values recorded so far in this call beside their lines.
 */
export function stepSource(view: ReplayView, index: number, around = 2, max = 60): SourceLine[] {
	const step = view.steps[index];
	const lines = step?.file ? view.files[step.file] : null;
	if (!step || !lines || !step.line) {
		return [];
	}
	const recorded = view.steps.filter((s) => s.fn === step.fn && s.file === step.file && s.line > 0).map((s) => s.line);
	let from = Math.max(1, Math.min(...recorded) - around);
	let to = Math.min(lines.length, Math.max(...recorded) + around);
	if (to - from + 1 > max) {
		// A long function: keep the current line in view.
		from = Math.max(from, step.line - Math.floor(max / 2));
		to = Math.min(to, from + max - 1);
	}
	const values = new Map<number, string>();
	for (const s of sameCall(view, index)) {
		if (s.values.length && s.line) {
			values.set(s.line, chip(s.values));
		}
	}
	const out: SourceLine[] = [];
	for (let n = from; n <= to; n++) {
		out.push({ n, text: lines[n - 1], current: n === step.line, values: values.get(n) ?? null });
	}
	return out;
}

/**
 * Recording that is still in a diff: the paths (from a unified diff's `+++ b/<path>` lines) whose
 * added lines hold the marker. The fix is never offered while this is not empty.
 */
export function leftoverRecording(files: { path: string; diff: string }[]): string[] {
	return files
		.filter((f) => /(^|\/)studio[-_]?replay\.[\w]+$/i.test(f.path) || f.diff.split('\n').some((l) => l.startsWith('+') && !l.startsWith('+++') && isMarker(l)))
		.map((f) => f.path);
}
