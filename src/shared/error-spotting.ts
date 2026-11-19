/**
 * Spotting errors in what a program prints: exceptions with their stack traces, failed tests,
 * and a non-zero exit code. Pure text in, records out, so it runs under `npm test` against
 * captured real output (shared/testdata/errors).
 *
 * The stream is read a line at a time. A line that begins a block (`fail:`, `Traceback`,
 * `panicked at`, a failed test's heading) opens it, the lines that belong to it are collected,
 * and the first line that does not closes it. What a closed block gives is the record that
 * Investigate receives: a one-line summary, the exception type, the frames that could be read
 * (crash site first) and the raw text.
 *
 * Everything here is untrusted program output: the records are shown as text only.
 */

export type ErrorRuntime = 'dotnet' | 'node' | 'python' | 'rust' | 'go' | 'unknown';

export interface ErrorFrame {
	/** As printed: usually absolute, sometimes relative to where the program ran. */
	file: string;
	line: number;
	column: number | null;
	fn: string | null;
}

export interface SpottedError {
	kind: 'exception' | 'test' | 'exit';
	runtime: ErrorRuntime;
	/** One line for the "Error spotted" bar. */
	summary: string;
	/** The exception's type ("NullReferenceException", "TypeError", "panic"). */
	type: string | null;
	message: string | null;
	/** The failed test's name, for a test failure. */
	test: string | null;
	/** The frames with a file and a line, crash site first. */
	frames: ErrorFrame[];
	/** The block as printed, without colour codes. */
	text: string;
	/** Where the block starts: the 0-based number of its first line in the output so far. */
	line: number;
}

const MAX_TEXT = 8000;
const MAX_BLOCK_LINES = 400;
/** How many lines back an already-spotted error still explains a non-zero exit code. */
const EXIT_EXPLAINED_WITHIN = 200;
const EXIT_TAIL = 30;

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_])/g;

/** Terminal output without its escape sequences. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

type BlockKind = 'dotnet-log' | 'trace' | 'python' | 'rust' | 'go' | 'dotnet-test' | 'cargo-test' | 'jest' | 'vitest' | 'pytest';

interface Block {
	kind: BlockKind;
	lines: string[];
	start: number;
	/** The block has had its last line; the next one closes it. */
	done: boolean;
	/** The request being handled when the block began, when the output said so. */
	request: string | null;
}

// ---- what begins a block --------------------------------------------------------

/** `System.NullReferenceException`, `TypeError`, `Error [ERR_X]`: a type name ending the way exception types do. */
const TYPE = String.raw`(?:[A-Za-z_$][\w$\`]*\.)*(?:[A-Z][\w$\`]*)?(?:Error|Exception)`;
const TRACE_HEAD = new RegExp(String.raw`^(?:Unhandled exception\. |Uncaught |Caused by: )?(${TYPE})(?: \[[\w.]+\])?(?:: ?(.*))?$`);
const DOTNET_LOG = /^(?:fail|crit): (\S.*)$/;
const DOTNET_EXCEPTION = new RegExp(String.raw`^\s*(?:---> )?(${TYPE})(?: ?: (.*))?$`);
const PYTHON_HEAD = /^Traceback \(most recent call last\):$/;
const PYTHON_CHAIN = /^(The above exception was the direct cause of the following exception:|During handling of the above exception, another exception occurred:)$/;
const RUST_PANIC = /^thread '(.+?)'(?: \(\d+\))? panicked at (?:'(.*)', )?(.+?):(\d+):(\d+):?$/;
const GO_PANIC = /^(?:panic|fatal error): (.*)$/;
const DOTNET_TEST = /^\s*Failed (\S+) \[[^\]]+\]$/;
const CARGO_TEST = /^---- (.+?) stdout ----$/;
const JEST_FAIL = /^FAIL\s+\S/;
const JEST_TEST = /^\s+● (.+)$/;
const VITEST_FAIL = /^\s*FAIL\s+(\S+) > (.+)$/;
const PYTEST_FAILURES = /^=+ FAILURES =+$/;
const PYTEST_SECTION = /^_{3,} (.+?) _{3,}$/;
const PYTEST_FAILED = /^FAILED (\S+?)(?:::(\S+))?(?: - (.*))?$/;
const RULE = /^[=_]{5,}/;

const REQUEST_START = /Request starting HTTP\/[\d.]+ ([A-Z]+) (?:https?:\/\/[^/\s]+)?(\/\S*)/;

// ---- frames -----------------------------------------------------------------------

const DOTNET_FRAME = /^\s*at (.+?)(?: in (.+?):line (\d+))?\s*$/;
const JS_FRAME = /^\s*at (?:async )?(?:(.+?) \()?((?:file:\/\/)?[^()\s][^()]*?):(\d+):(\d+)\)?$/;
const PYTHON_FRAME = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?$/;
const GO_FILE = /^\t(.+?\.go):(\d+)(?: \+0x[0-9a-f]+)?$/;
const VITEST_FRAME = /^\s*❯ (?:(.+?) )?(\S+?):(\d+):(\d+)$/;
const PYTEST_FRAME = /^(\S+?\.py):(\d+): ?(\w*)$/;

/** `Shop.Pricing.PricingService.ApplyDiscount(Order order)` -> `Shop.Pricing.PricingService.ApplyDiscount`. */
function dotnetFn(call: string): string {
	const open = call.indexOf('(');
	return (open < 0 ? call : call.slice(0, open)).trim();
}

/** The last part of a qualified name, as a person would say it: `ApplyDiscount`, `applyDiscount`, `apply_discount`. */
function shortName(name: string | null): string | null {
	if (!name) {
		return null;
	}
	const cleaned = name.replace(/\(.*$/, '').replace(/^(?:async |new )/, '').replace(/ \[as .*\]$/, '');
	const last = cleaned.split(/[.:]+|::/).filter(Boolean).pop() ?? cleaned;
	// Compiler-made names (`<Main>$`, `<anonymous>`, lambdas) say nothing.
	return /^[\w$]+$/.test(last) && !/^lambda_method/.test(last) ? last : null;
}

function shortType(type: string): string {
	return type.split('.').pop() ?? type;
}

function dotnetFrames(lines: string[]): ErrorFrame[] {
	const frames: ErrorFrame[] = [];
	for (const line of lines) {
		const m = DOTNET_FRAME.exec(line);
		if (m?.[2]) {
			frames.push({ file: m[2], line: Number(m[3]), column: null, fn: dotnetFn(m[1]) });
		}
	}
	return frames;
}

function jsFrames(lines: string[]): ErrorFrame[] {
	const frames: ErrorFrame[] = [];
	for (const line of lines) {
		const m = JS_FRAME.exec(line);
		// `node:internal/...` is not a file anyone can open.
		if (m && !m[2].startsWith('node:')) {
			frames.push({ file: m[2].replace(/^file:\/\//, ''), line: Number(m[3]), column: Number(m[4]), fn: m[1] ?? null });
		}
	}
	return frames;
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function exceptionSummary(type: string | null, message: string | null, fn: string | null): string {
	const name = type ? shortType(type) : 'Error';
	const where = shortName(fn);
	if (where) {
		return `${name} in ${where}`;
	}
	return message ? cut(`${name}: ${message}`, 140) : name;
}

// ---- closing a block: the record it gives ---------------------------------------------

type Found = Omit<SpottedError, 'text' | 'line'>;

function finishDotnetLog(b: Block): Found | null {
	const body = b.lines.slice(1);
	const at = body.findIndex((l) => DOTNET_EXCEPTION.test(l) && !/^\s*at /.test(l));
	if (at < 0) {
		return null; // an error-level log line with no exception is not a crash
	}
	const [, type, message] = DOTNET_EXCEPTION.exec(body[at])!;
	const trace = body.slice(at + 1);
	const frames = dotnetFrames(trace);
	// The function named is the first one with a file: the user's own code, not the framework's.
	const what = exceptionSummary(type, message ?? null, frames[0]?.fn ?? null);
	const inRequest = body.some((l) => /while executing the request/i.test(l));
	const summary = b.request && inRequest ? `${b.request} returned 500 · ${what}` : what;
	return { kind: 'exception', runtime: 'dotnet', summary, type: shortType(type), message: message?.trim() || null, test: null, frames };
}

function finishTrace(b: Block): Found | null {
	const head = TRACE_HEAD.exec(b.lines[0]);
	const trace = b.lines.slice(1);
	if (!head || !trace.some((l) => /^\s+at /.test(l))) {
		return null; // "SomethingError: text" with no stack under it is a log line
	}
	const dotnet = /^Unhandled exception\. /.test(b.lines[0]) || trace.some((l) => / in .+:line \d+\s*$/.test(l)) || (head[1].includes('.') && !trace.some((l) => JS_FRAME.test(l)));
	const frames = dotnet ? dotnetFrames(trace) : jsFrames(trace);
	return { kind: 'exception', runtime: dotnet ? 'dotnet' : 'node', summary: exceptionSummary(head[1], head[2] ?? null, frames[0]?.fn ?? null), type: shortType(head[1]), message: head[2]?.trim() || null, test: null, frames };
}

function finishPython(b: Block): Found | null {
	// Chained tracebacks arrive as one block; the first is where it went wrong, the last is what the program died of.
	const parts: { frames: ErrorFrame[]; last: string }[] = [];
	for (const line of b.lines) {
		if (PYTHON_HEAD.test(line)) {
			parts.push({ frames: [], last: '' });
			continue;
		}
		const part = parts[parts.length - 1];
		if (!part) {
			continue;
		}
		const m = PYTHON_FRAME.exec(line);
		if (m) {
			part.frames.push({ file: m[1], line: Number(m[2]), column: null, fn: m[3] && m[3] !== '<module>' ? m[3] : null });
		} else if (line && !/^\s/.test(line) && !PYTHON_CHAIN.test(line)) {
			part.last = line;
		}
	}
	const final = parts[parts.length - 1];
	if (!final?.last) {
		return null;
	}
	const [, type, message] = /^([\w.]+)(?:: (.*))?$/.exec(final.last) ?? [null, final.last, null];
	// Python lists the most recent call last.
	const frames = parts.flatMap((p) => [...p.frames].reverse());
	return { kind: 'exception', runtime: 'python', summary: exceptionSummary(type ?? null, message ?? null, final.frames[final.frames.length - 1]?.fn ?? null), type: type ? shortType(type) : null, message: message ?? null, test: null, frames };
}

function rustPanic(lines: string[]): { frame: ErrorFrame; message: string; thread: string } | null {
	const at = lines.findIndex((l) => RUST_PANIC.test(l));
	if (at < 0) {
		return null;
	}
	const m = RUST_PANIC.exec(lines[at])!;
	const said: string[] = [];
	for (const line of lines.slice(at + 1)) {
		if (!line.trim() || /^note: /.test(line) || /^stack backtrace:/.test(line)) {
			break;
		}
		said.push(line.trim());
	}
	return { frame: { file: m[3], line: Number(m[4]), column: Number(m[5]), fn: null }, message: m[2] ?? said.join(' '), thread: m[1] };
}

function finishRust(b: Block): Found | null {
	const p = rustPanic(b.lines);
	return p && { kind: 'exception', runtime: 'rust', summary: cut(`Panic at ${p.frame.file}:${p.frame.line}${p.message ? ` · ${p.message}` : ''}`, 160), type: 'panic', message: p.message || null, test: null, frames: [p.frame] };
}

function finishGo(b: Block): Found | null {
	const message = GO_PANIC.exec(b.lines[0])?.[1] ?? '';
	const frames: ErrorFrame[] = [];
	for (let i = 1; i < b.lines.length; i++) {
		const m = GO_FILE.exec(b.lines[i]);
		if (m) {
			const fn = /^\S.*\)$/.test(b.lines[i - 1]) ? b.lines[i - 1].replace(/\(.*\)$/, '') : null;
			frames.push({ file: m[1], line: Number(m[2]), column: null, fn });
		}
	}
	// A panic with no goroutine trace under it is somebody's log line that happens to start with the word.
	if (!frames.length && !b.lines.some((l) => /^goroutine \d+ \[/.test(l))) {
		return null;
	}
	const where = shortName(frames[0]?.fn ?? null);
	return { kind: 'exception', runtime: 'go', summary: cut(where ? `panic in ${where} · ${message}` : `panic: ${message}`, 160), type: 'panic', message: message || null, test: null, frames };
}

function testSummary(test: string, type: string | null, fn: string | null, message: string | null): string {
	const name = test.split(/[.:>›]+\s*|::/).filter(Boolean).pop()?.trim() ?? test;
	const why = type ? exceptionSummary(type, message, fn) : message ? cut(message, 100) : '';
	return cut(why ? `${name} failed · ${why}` : `${name} failed`, 180);
}

function finishDotnetTest(b: Block): Found | null {
	const test = DOTNET_TEST.exec(b.lines[0])?.[1] ?? '';
	const at = b.lines.findIndex((l) => /^\s*Error Message:\s*$/.test(l));
	const said = at >= 0 ? (b.lines[at + 1] ?? '').trim() : '';
	// xUnit writes `Type : message`; an assertion has no type worth naming.
	const typed = new RegExp(String.raw`^(${TYPE}) ?: (.*)$`).exec(said);
	const type = typed && !/^Xunit\.|^NUnit\.|Assert/.test(typed[1]) ? shortType(typed[1]) : null;
	const message = (typed ? typed[2] : said) || null;
	const frames = dotnetFrames(b.lines);
	return { kind: 'test', runtime: 'dotnet', summary: testSummary(test, type, type ? (frames[0]?.fn ?? null) : null, message), type, message, test, frames };
}

function finishCargoTest(b: Block): Found | null {
	const test = CARGO_TEST.exec(b.lines[0])?.[1] ?? '';
	const p = rustPanic(b.lines);
	return { kind: 'test', runtime: 'rust', summary: testSummary(test, null, null, p?.message ?? null), type: p ? 'panic' : null, message: p?.message ?? null, test, frames: p ? [p.frame] : [] };
}

function jsError(lines: string[]): { type: string | null; message: string | null } {
	for (const line of lines) {
		const m = TRACE_HEAD.exec(line.trim());
		if (m) {
			return { type: shortType(m[1]), message: m[2]?.trim() || null };
		}
	}
	return { type: null, message: lines.map((l) => l.trim()).find((l) => l && !/^at |^[❯>|\d]/.test(l)) ?? null };
}

function finishJest(b: Block): Found | null {
	const test = JEST_TEST.exec(b.lines[0])?.[1] ?? '';
	const body = b.lines.slice(1);
	const { type, message } = jsError(body);
	const frames = jsFrames(body);
	// An assertion ("expect(received)...") is not an exception: say what was expected instead of a type.
	const plain = type && /^Assertion|^JestAssertion/.test(type) ? null : type;
	return { kind: 'test', runtime: 'node', summary: testSummary(test, plain, plain ? (frames[0]?.fn ?? null) : null, message), type: plain, message, test, frames };
}

function finishVitest(b: Block): Found | null {
	const head = VITEST_FAIL.exec(b.lines[0]);
	const test = head ? `${head[1]} > ${head[2]}` : '';
	const body = b.lines.slice(1);
	const { type, message } = jsError(body);
	const frames: ErrorFrame[] = [];
	for (const line of body) {
		const m = VITEST_FRAME.exec(line);
		if (m) {
			frames.push({ file: m[2], line: Number(m[3]), column: Number(m[4]), fn: m[1] ?? null });
		}
	}
	const plain = type && /^Assertion/.test(type) ? null : type;
	return { kind: 'test', runtime: 'node', summary: testSummary(head?.[2] ?? test, plain, plain ? (frames[0]?.fn ?? null) : null, message), type: plain, message, test, frames };
}

function finishPytest(b: Block): Found | null {
	const test = PYTEST_SECTION.exec(b.lines[0])?.[1] ?? '';
	const frames: ErrorFrame[] = [];
	let type: string | null = null;
	for (const line of b.lines) {
		const m = PYTEST_FRAME.exec(line);
		if (m) {
			frames.push({ file: m[1], line: Number(m[2]), column: null, fn: null });
			type = m[3] || type;
		}
	}
	const said = b.lines.find((l) => /^E\s+\S/.test(l))?.replace(/^E\s+/, '') ?? null;
	const message = said && type && said.startsWith(`${type}: `) ? said.slice(type.length + 2) : said;
	const plain = type === 'AssertionError' ? null : type;
	// pytest lists the test's own line first and where it blew up last.
	return { kind: 'test', runtime: 'python', summary: testSummary(test, plain, null, message), type: plain, message, test, frames: frames.reverse() };
}

const FINISH: Record<BlockKind, (b: Block) => Found | null> = {
	'dotnet-log': finishDotnetLog,
	trace: finishTrace,
	python: finishPython,
	rust: finishRust,
	go: finishGo,
	'dotnet-test': finishDotnetTest,
	'cargo-test': finishCargoTest,
	jest: finishJest,
	vitest: finishVitest,
	pytest: finishPytest,
};

// ---- the spotter ------------------------------------------------------------------------

/**
 * Reads a program's output as it arrives. `push` takes whatever arrived (colour codes and all,
 * cut anywhere) and answers the errors that are now complete; `flush` closes a block the stream
 * has gone quiet in the middle of; `end` is the program ending with its exit code.
 */
export class ErrorSpotter {
	/** Lines read so far. */
	lines = 0;
	private _partial = '';
	private _open: Block | null = null;
	/** A Python traceback that has ended, held in case another is chained to it. */
	private _held: Block | null = null;
	private _request: string | null = null;
	private _jest = false;
	private _pytest = false;
	/** Tests already reported from their own section, so pytest's summary lines do not repeat them. */
	private readonly _reported = new Set<string>();
	/** A `cargo test` run reported a failed test of its own. */
	private _cargoFailed = false;
	private _lastError = -Infinity;
	private readonly _tail: string[] = [];
	private _out: SpottedError[] = [];

	push(chunk: string): SpottedError[] {
		const text = this._partial + chunk;
		const lines = text.split('\n');
		this._partial = lines.pop() ?? '';
		for (const raw of lines) {
			this.feed(raw);
		}
		return this.take();
	}

	/** The stream has gone quiet: what is open is as complete as it will get. */
	flush(): SpottedError[] {
		this.close();
		this.release();
		return this.take();
	}

	/** The program ended. A non-zero exit code is itself an error unless one was just spotted. */
	end(code: number | null): SpottedError[] {
		if (this._partial) {
			this.feed(this._partial);
			this._partial = '';
		}
		this.close();
		this.release();
		if (code && this.lines - this._lastError > EXIT_EXPLAINED_WITHIN) {
			this._out.push({ kind: 'exit', runtime: 'unknown', summary: `Exited with code ${code}`, type: null, message: null, test: null, frames: [], text: this._tail.join('\n'), line: Math.max(0, this.lines - this._tail.length) });
			this._lastError = this.lines;
		}
		return this.take();
	}

	private take(): SpottedError[] {
		const out = this._out;
		this._out = [];
		return out;
	}

	private feed(raw: string): void {
		// A carriage return rewinds the line (progress bars): what is left on screen is what follows the last one.
		const line = stripAnsi(raw).replace(/\r$/, '').split('\r').pop()!;
		const n = this.lines++;
		this._tail.push(line);
		if (this._tail.length > EXIT_TAIL) {
			this._tail.shift();
		}

		if (this._open) {
			if (this.continues(this._open, line)) {
				if (this._open.lines.length < MAX_BLOCK_LINES) {
					this._open.lines.push(line);
				}
				return;
			}
			this.close();
		}
		if (this._held) {
			// Blank lines and the sentence that links two tracebacks keep the first one waiting.
			if (!line.trim() || PYTHON_CHAIN.test(line)) {
				this._held.lines.push(line);
				return;
			}
			if (PYTHON_HEAD.test(line)) {
				this._held.lines.push(line);
				this._held.done = false;
				this._open = this._held;
				this._held = null;
				return;
			}
			this.release();
		}

		this.context(line);
		const kind = this.starts(line);
		if (kind) {
			this._open = { kind, lines: [line], start: n, done: kind === 'rust' && /panicked at '.*', /.test(line), request: this._request };
		} else {
			this.loose(line, n);
		}
	}

	/** What the surrounding output says about what the program is doing. */
	private context(line: string): void {
		const request = REQUEST_START.exec(line);
		if (request) {
			this._request = `${request[1]} ${request[2].split('?')[0]}`;
		}
		if (JEST_FAIL.test(line)) {
			this._jest = true;
		} else if (/^(Test Suites:|PASS\s)/.test(line)) {
			this._jest = false;
		}
		if (PYTEST_FAILURES.test(line)) {
			this._pytest = true;
		} else if (/^=+ (short test summary info|warnings summary|\d+ (failed|passed|error)).*=+$/.test(line)) {
			this._pytest = false;
		}
		if (/^running \d+ tests?$/.test(line)) {
			this._cargoFailed = false;
		}
	}

	private starts(line: string): BlockKind | null {
		if (DOTNET_LOG.test(line)) {
			return 'dotnet-log';
		}
		if (PYTHON_HEAD.test(line)) {
			return 'python';
		}
		if (RUST_PANIC.test(line)) {
			return 'rust';
		}
		if (GO_PANIC.test(line)) {
			return 'go';
		}
		if (DOTNET_TEST.test(line)) {
			return 'dotnet-test';
		}
		if (CARGO_TEST.test(line)) {
			return 'cargo-test';
		}
		if (VITEST_FAIL.test(line)) {
			return 'vitest';
		}
		if (this._jest && JEST_TEST.test(line)) {
			return 'jest';
		}
		if (this._pytest && PYTEST_SECTION.test(line)) {
			return 'pytest';
		}
		return TRACE_HEAD.test(line) ? 'trace' : null;
	}

	/** Does `line` still belong to the open block? */
	private continues(b: Block, line: string): boolean {
		if (b.done) {
			return false;
		}
		const blank = !line.trim();
		switch (b.kind) {
			case 'dotnet-log':
				// The console logger indents everything after an entry's first line.
				return /^\s{2,}\S/.test(line);
			case 'trace':
				return /^\s+at /.test(line) || /^\s*--- End of /.test(line) || /^\s*---> /.test(line) || /^\s+\.\.\. \d+ more/.test(line);
			case 'python':
				// Indented lines are frames and source; the first line that is not is the exception, and the last.
				if (!/^\s/.test(line) && !blank) {
					b.done = true;
				}
				return !blank || b.lines.length > 1;
			case 'rust':
				return !blank && !/^note: /.test(line) && b.lines.length < 12;
			case 'go':
				if (/^exit status \d+/.test(line)) {
					b.done = true;
					return true;
				}
				return blank || /^(goroutine \d+ \[|\[signal |\t|created by )/.test(line) || /^[^\s:]+\(.*\)$/.test(line);
			case 'dotnet-test':
				return !DOTNET_TEST.test(line) && (blank || /^\s/.test(line));
			case 'cargo-test':
				return !/^(failures:|---- .+ ----|test result:)/.test(line);
			case 'jest':
				return !JEST_TEST.test(line) && (blank || /^\s/.test(line));
			case 'vitest':
				return !/^⎯{3,}/.test(line) && !VITEST_FAIL.test(line) && !/^\s*Test Files\s/.test(line);
			case 'pytest':
				return !RULE.test(line);
		}
	}

	private close(): void {
		const b = this._open;
		if (!b) {
			return;
		}
		this._open = null;
		if (b.kind === 'python') {
			// Not yet: another traceback may be chained to this one.
			this._held = b;
			return;
		}
		this.emit(b);
	}

	private release(): void {
		const held = this._held;
		this._held = null;
		if (held) {
			this.emit(held);
		}
	}

	private emit(b: Block): void {
		const found = FINISH[b.kind](b);
		if (!found) {
			return;
		}
		while (b.lines.length && !b.lines[b.lines.length - 1].trim()) {
			b.lines.pop();
		}
		if (found.test) {
			this._reported.add(found.test);
		}
		if (b.kind === 'cargo-test') {
			this._cargoFailed = true;
		}
		this._lastError = b.start + b.lines.length;
		this._out.push({ ...found, text: cut(b.lines.join('\n'), MAX_TEXT), line: b.start });
	}

	/** One-line failures that have no block of their own. */
	private loose(line: string, n: number): void {
		const failed = PYTEST_FAILED.exec(line);
		if (failed && /\.py$/.test(failed[1])) {
			const test = failed[2] ?? failed[1];
			// Already told in full from the FAILURES section above.
			if (!this._reported.has(test) && !this._reported.has(test.split('::').pop() ?? test)) {
				this._reported.add(test);
				this._lastError = n;
				this._out.push({ kind: 'test', runtime: 'python', summary: testSummary(test, null, null, failed[3] ?? null), type: null, message: failed[3] ?? null, test, frames: [], text: line, line: n });
			}
			return;
		}
		if (/^test result: FAILED\./.test(line) && !this._cargoFailed) {
			this._lastError = n;
			this._out.push({ kind: 'test', runtime: 'rust', summary: cut(line.replace(/^test result: FAILED\.\s*/, 'Tests failed · ').replace(/;? finished in .*$/, ''), 160), type: null, message: null, test: null, frames: [], text: line, line: n });
		}
	}
}

/** Everything in a finished piece of output, as `ErrorSpotter` would have found it live. */
export function spotErrors(text: string, exitCode: number | null = null): SpottedError[] {
	const spotter = new ErrorSpotter();
	return [...spotter.push(text), ...spotter.end(exitCode)];
}

/**
 * The frame to show as "crashed here": the first one whose file is inside `root` (an absolute
 * folder, `/` or `\` separated) or is relative, as a repository-relative path. Frames from the
 * runtime's own folders and from dependencies are passed over.
 */
export function crashSite(error: SpottedError, toRelative: (file: string) => string | null): { path: string; line: number; column: number | null } | null {
	for (const frame of error.frames) {
		const path = toRelative(frame.file);
		if (path && !/(^|\/)(node_modules|site-packages|\.venv|vendor)\//.test(path)) {
			return { path, line: frame.line, column: frame.column };
		}
	}
	return null;
}
