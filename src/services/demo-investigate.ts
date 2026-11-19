/**
 * Run & Investigate in the browser preview: the demo repository's run targets, a run that
 * crashes, and a pretend investigation of that crash (approval card, report, a recording to
 * replay). Kept apart from the demo backend so that file only gains a few `case` lines.
 *
 * The story: with repeat on and nothing queued, `Queue.next()` returns null, and the key
 * handler in src/main.ts reads `.title` of it.
 */
import type { ChangedFile, InvestigateApproval, ReplayData, RunTarget, WorktreeDiff } from './backend.service';
import { demoReadFile } from './demo-files';

export const DEMO_TARGETS: RunTarget[] = [
	{ id: 'node::build', name: 'build', group: 'package.json', cwd: '', argv: ['npm', 'run', 'build'], kind: 'run', runtime: 'node', source: 'package.json' },
	{ id: 'node::dev', name: 'dev', group: 'package.json', cwd: '', argv: ['npm', 'run', 'dev'], kind: 'run', runtime: 'node', source: 'package.json' },
	{ id: 'node::test', name: 'test', group: 'package.json', cwd: '', argv: ['npm', 'test'], kind: 'test', runtime: 'node', source: 'package.json' },
];

const CRASH = "TypeError: Cannot read properties of null (reading 'title')";

/** What a demo target prints: lines with the delay (ms) before each, then how it ends (no code: it keeps running). */
export function demoRunScript(target: RunTarget, root: string, port: number | null): { lines: [delay: number, text: string][]; exit: number | null } {
	const head: [number, string][] = [
		[150, ''],
		[0, `> harmony@1.4.0 ${target.name}`],
	];
	if (target.name === 'test') {
		return {
			lines: [
				...head,
				[0, '> vitest run'],
				[500, ''],
				[0, ' \x1b[30;46m RUN \x1b[0m v3.2.7 ' + root],
				[700, ''],
				[0, ' \x1b[33m❯\x1b[0m src/player/queue.test.ts (3 tests | \x1b[31m1 failed\x1b[0m) 6ms'],
				[0, '   \x1b[32m✓\x1b[0m Queue > advances to the next track 1ms'],
				[0, '   \x1b[32m✓\x1b[0m Queue > wraps when repeat is on 0ms'],
				[0, '   \x1b[31m×\x1b[0m Queue > repeat on an empty queue plays nothing 3ms'],
				[0, ''],
				[0, '\x1b[31m⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\x1b[0m'],
				[0, ''],
				[0, ' \x1b[41m FAIL \x1b[0m src/player/queue.test.ts > Queue > repeat on an empty queue plays nothing'],
				[0, CRASH],
				[0, ' ❯ src/main.ts:12:47'],
				[0, ' ❯ src/player/queue.test.ts:21:3'],
				[0, ''],
				[0, '\x1b[31m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\x1b[0m'],
				[0, ''],
				[0, ' Test Files  \x1b[31m1 failed\x1b[0m (1)'],
				[0, '      Tests  \x1b[31m1 failed\x1b[0m | 2 passed (3)'],
			],
			exit: 1,
		};
	}
	if (target.name === 'build') {
		return { lines: [...head, [0, '> tsc --noEmit && vite build'], [900, ''], [0, 'vite v7.1.0 building for production...'], [600, '\x1b[32m✓\x1b[0m 14 modules transformed.'], [200, 'dist/index.js  3.21 kB'], [0, '\x1b[32m✓ built in 412ms\x1b[0m']], exit: 0 };
	}
	return {
		lines: [
			...head,
			[0, '> vite'],
			[600, ''],
			[0, `  \x1b[32m\x1b[1mVITE\x1b[0m\x1b[32m v7.1.0\x1b[0m  ready in 312 ms`],
			[0, ''],
			[0, `  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   http://localhost:${port ?? 5173}/`],
			[0, '  \x1b[2m➜  press h + enter to show help\x1b[0m'],
			[1400, '\x1b[2m[player]\x1b[0m key r: repeat is now all'],
			[900, '\x1b[2m[player]\x1b[0m key ArrowRight'],
			[60, `\x1b[31m${CRASH}\x1b[0m`],
			[0, `    at HTMLDocument.<anonymous> (${root}/src/main.ts:12:47)`],
			[0, `    at Queue.next (${root}/src/player/queue.ts:15:10)`],
			[400, '\x1b[2m[player]\x1b[0m the page reloaded'],
		],
		exit: null,
	};
}

// ---- the recording ----------------------------------------------------------------

const MARK = '// studio-replay';

/** A file with recording lines put in after the given (clean) line numbers, and where each ended up. */
function instrument(text: string, inserts: [after: number, code: string][]): { text: string; at: number[] } {
	const lines = text.split('\n');
	const out: string[] = [];
	const at: number[] = [];
	lines.forEach((line, i) => {
		out.push(line);
		inserts.forEach(([after, code], n) => {
			if (after === i + 1) {
				const indent = /^\s*/.exec(lines[i + 1] && lines[i + 1].trim() ? lines[i + 1] : line)?.[0] ?? '';
				out.push(`${indent}${code} ${MARK}`);
				at[n] = out.length;
			}
		});
	});
	return { text: out.join('\n'), at };
}

/** The demo recording: the two files as they "ran" (recording lines in), and the events they wrote. */
export function demoReplay(root: string): ReplayData {
	const main = instrument(demoReadFile('src/main.ts').text, [
		[2, "import { enter, thrown } from './studio-replay';"],
		[7, "enter('keydown', { key: e.key, repeat });"],
		[11, 'try {'],
		[12, "} catch (error) { thrown('keydown', error); throw error; }"],
	]);
	const queue = instrument(demoReadFile('src/player/queue.ts').text, [
		[1, "import { enter, line, ret } from '../studio-replay';"],
		[8, "enter('Queue.next', { repeat, length: this._items.length, cursor: this._cursor });"],
		[9, "line('Queue.next', { atEnd: this._cursor + 1 >= this._items.length });"],
		[13, "line('Queue.next', { cursor: this._cursor, items: this._items.length });"],
		[14, "ret('Queue.next', { returns: this._items[this._cursor + 1] ?? null });"],
	]);
	const event = (kind: string, fn: string, file: string, line: number, values: Record<string, string>): string => JSON.stringify({ event: kind, fn, file: `${root}/${file}`, line, values });
	const events = [
		event('enter', 'keydown', 'src/main.ts', main.at[1], { key: '"ArrowRight"', repeat: '"all"' }),
		event('enter', 'Queue.next', 'src/player/queue.ts', queue.at[1], { repeat: 'true', length: '0', cursor: '0' }),
		event('line', 'Queue.next', 'src/player/queue.ts', queue.at[2], { atEnd: 'true' }),
		event('line', 'Queue.next', 'src/player/queue.ts', queue.at[3], { cursor: '-1', items: '0' }),
		event('return', 'Queue.next', 'src/player/queue.ts', queue.at[4], { returns: 'null' }),
		event('throw', 'keydown', 'src/main.ts', main.at[3], { error: CRASH }),
	];
	return {
		run: 1,
		events: `${events.join('\n')}\n`,
		files: [
			{ path: 'src/main.ts', text: main.text },
			{ path: 'src/player/queue.ts', text: queue.text },
		],
	};
}

// ---- the investigation ------------------------------------------------------------

export const DEMO_REPORT = {
	found: true,
	summary: 'Skipping ahead with repeat on and nothing queued crashes the player: next() returns null for an empty queue, and the key handler reads the title of whatever it gets.',
	path: [
		{ fn: 'keydown handler', file: 'src/main.ts', line: 7, values: { key: '"ArrowRight"', repeat: '"all"' }, role: null },
		{ fn: 'Queue.next', file: 'src/player/queue.ts', line: 9, values: { length: '0', atEnd: 'true' }, role: null },
		{ fn: 'Queue.next', file: 'src/player/queue.ts', line: 13, values: { cursor: '-1', items: '0' }, role: null },
		{ fn: 'Queue.next', file: 'src/player/queue.ts', line: 15, values: { returns: 'null' }, role: 'cause' },
		{ fn: 'keydown handler', file: 'src/main.ts', line: 12, values: { track: 'null', 'track.title': 'TypeError' }, role: 'crash' },
	],
	evidence: [
		{ status: 'ruled-out', title: 'Repeat was off', detail: 'Recorded `repeat = "all"` when the key arrived, so `next()` was asked to wrap.', refs: ['src/main.ts:11'] },
		{ status: 'confirmed', title: 'The queue was empty', detail: 'Recorded `length = 0`. With repeat on, the cursor is reset to `-1` and then moved to slot `0`, which does not exist, so `next()` returns `null`.', refs: ['src/player/queue.ts:13', 'src/player/queue.ts:15'] },
		{ status: 'also-found', title: 'previous() has the same gap', detail: 'It also returns `null` for an empty queue. Nothing reads its result yet, so it does not crash today.', refs: ['src/player/queue.ts:20'] },
	],
	run: 1,
	causeSeq: 5,
	crashSeq: 6,
	notes: {
		'2': 'Repeat is on, and the queue has no tracks at all.',
		'4': 'Repeat sends the cursor back to the start, but there is no start to go back to.',
		'5': 'This is the cause. An empty queue has no next track even with repeat on, so `null` is the right answer here. The caller is what does not expect it.',
		'6': 'The crash is in the key handler, one call away from the cause: it reads `.title` of the `null` it was given. A breakpoint here would only have shown that the track is null, not why.',
	},
	test: { name: 'repeat on an empty queue plays nothing', failsBefore: true, passesAfter: true },
};

const FIX_DIFF = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -9,6 +9,9 @@ document.addEventListener('keydown', (e) => {
 		repeat = nextRepeatMode(repeat);
 	}
 	if (e.key === 'ArrowRight') {
-		document.title = queue.next(repeat !== 'off')!.title;
+		const track = queue.next(repeat !== 'off');
+		if (track) {
+			document.title = track.title; // nothing queued: leave the title alone
+		}
 	}
 });
`;

const TEST_DIFF = `diff --git a/src/player/queue.test.ts b/src/player/queue.test.ts
new file mode 100644
--- /dev/null
+++ b/src/player/queue.test.ts
@@ -0,0 +1,9 @@
+import { expect, it } from 'vitest';
+import { Queue } from './queue';
+
+it('repeat on an empty queue plays nothing', () => {
+	const queue = new Queue();
+	expect(queue.next(true)).toBeNull();
+	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
+	expect(document.title).toBe('Harmony');
+});
`;

/** What the demo investigation's worktree "changed": the fix and its test. */
export function demoFix(): WorktreeDiff {
	const files: ChangedFile[] = [
		{ path: 'src/main.ts', oldPath: null, status: 'modified', diff: FIX_DIFF },
		{ path: 'src/player/queue.test.ts', oldPath: null, status: 'untracked', diff: TEST_DIFF },
	];
	return { base: 'b'.repeat(40), head: 'd'.repeat(40), files, tooLarge: false };
}

export function demoApproval(key: string, request: string): InvestigateApproval {
	return {
		key,
		request,
		tool: 'run_target',
		target: 'dev',
		group: 'package.json',
		project: null,
		command: 'npm run dev',
		port: 5174,
		method: null,
		path: null,
		body: null,
		touches: 'Nothing outside the worktree: the player keeps its queue in memory and talks to no server.',
	};
}

/** The steps before Claude asks to run: [delay, step, detail, thinking]. */
export const DEMO_BEFORE: [number, number, string | null, string | null][] = [
	[500, 1, 'src/main.ts, src/player/queue.ts, src/player/repeat.ts', null],
	[1500, 2, 'ArrowRight with repeat on, before any track is queued', '`next()` can return `null` in two places: when repeat is off at the end of the queue (`src/player/queue.ts:11`), and when the slot it lands on is empty (`src/player/queue.ts:15`). The recording will show which one this key press hits.'],
	[2500, 3, 'Queue.next and the key handler', null],
	[3300, 4, null, null],
];

/** And after the run was allowed. */
export const DEMO_AFTER: [number, number, string | null, string | null][] = [
	[2600, 5, 'Read run-1.jsonl: 6 steps', 'Repeat was on (`"all"`), so the early return is not it. The queue was empty: the cursor went to `-1`, then to slot `0`, which holds nothing. `next()` answering `null` is right; the key handler in `src/main.ts:12` is what does not expect it.'],
	[3900, 6, 'Guarded the title update, added a test', null],
];

/** What Claude says when the user chose "Don't run". */
export const DEMO_DENIED = {
	found: false,
	summary: 'Without running it I can only say what the code allows: `next()` returns null in two cases, and the key handler does not expect either. A recorded run would show which one you hit.',
	path: [],
	evidence: [{ status: 'also-found', title: 'The key handler assumes a track', detail: '`src/main.ts:12` reads `.title` of whatever `next()` returns.', refs: ['src/main.ts:12'] }],
	run: null,
	causeSeq: null,
	crashSeq: null,
	notes: {},
	test: null,
};
