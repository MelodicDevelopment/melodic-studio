/**
 * The demo repository's working tree, for the Files tab in the browser preview.
 * Kept apart from the demo backend so that file only gains three `case` lines.
 */
import type { FileContent, OnConflict, Placed, TreeEntry } from './backend.service';

const BINARY = '\u0000binary';

const IGNORED = ['node_modules', 'dist', 'debug.log'];

const FILES = new Map<string, string>([
	['.gitignore', 'node_modules/\ndist/\n*.log\n'],
	['README.md', '# harmony\n\nA small music player.\n\n## Develop\n\n```sh\nnpm install\nnpm run dev\n```\n'],
	['package.json', '{\n\t"name": "harmony",\n\t"version": "1.4.0",\n\t"type": "module",\n\t"scripts": {\n\t\t"dev": "vite",\n\t\t"build": "tsc --noEmit && vite build",\n\t\t"test": "vitest run"\n\t}\n}\n'],
	['debug.log', 'queue: wrapped at 12\n'],
	['public/cover.png', BINARY],
	['public/index.html', '<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="UTF-8" />\n\t\t<title>Harmony</title>\n\t</head>\n\t<body>\n\t\t<div id="app"></div>\n\t</body>\n</html>\n'],
	['docs/shortcuts.md', '# Keyboard shortcuts\n\n| Key | Action |\n| --- | --- |\n| Space | Play / pause |\n| R | Cycle repeat mode |\n'],
	['src/main.ts', "import { Queue } from './player/queue';\nimport { nextRepeatMode, type RepeatMode } from './player/repeat';\n\nconst queue = new Queue();\nlet repeat: RepeatMode = 'off';\n\ndocument.addEventListener('keydown', (e) => {\n\tif (e.key === 'r') {\n\t\trepeat = nextRepeatMode(repeat);\n\t}\n\tif (e.key === 'ArrowRight') {\n\t\tdocument.title = queue.next(repeat !== 'off')!.title;\n\t}\n});\n"],
	['src/styles/app.css', ':root {\n\t--accent: #7c9cff;\n}\n\nbody {\n\tmargin: 0;\n\tfont-family: system-ui, sans-serif;\n}\n\n.transport button.on {\n\tcolor: var(--accent);\n}\n'],
	[
		'src/player/queue.ts',
		"import type { Track } from './track';\n\nexport class Queue {\n\tprivate _items: Track[] = [];\n\tprivate _cursor = 0;\n\n\t/** Advance and return the next track, wrapping when repeat is on. */\n\tnext(repeat = false): Track | null {\n\t\tif (this._cursor + 1 >= this._items.length) {\n\t\t\tif (!repeat) {\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tthis._cursor = -1;\n\t\t}\n\t\treturn this._items[++this._cursor] ?? null;\n\t}\n\n\tprevious(): Track | null {\n\t\tthis._cursor = Math.max(0, this._cursor - 1);\n\t\treturn this._items[this._cursor] ?? null;\n\t}\n\n\tclear(): void {\n\t\tthis._items = [];\n\t}\n\n\tget length(): number {\n\t\treturn this._items.length;\n\t}\n}\n",
	],
	['src/player/repeat.ts', "export type RepeatMode = 'off' | 'all' | 'one';\n\nconst ORDER: RepeatMode[] = ['off', 'all', 'one'];\n\nexport function nextRepeatMode(mode: RepeatMode): RepeatMode {\n\treturn ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];\n}\n"],
	['src/player/track.ts', 'export interface Track {\n\tid: string;\n\ttitle: string;\n\tartist: string;\n\tseconds: number;\n}\n'],
	['node_modules/vite/package.json', '{\n\t"name": "vite"\n}\n'],
	['dist/index.js', 'console.log("built");\n'],
]);

/** Folders with nothing in them yet (every other folder is implied by the files under it). */
const EMPTY_DIRS = new Set<string>();

export function demoListDir(dir: string): TreeEntry[] {
	const prefix = dir ? `${dir}/` : '';
	const seen = new Map<string, TreeEntry>();
	for (const path of [...FILES.keys(), ...[...EMPTY_DIRS].map((d) => `${d}/`)]) {
		if (!path.startsWith(prefix)) {
			continue;
		}
		const rest = path.slice(prefix.length);
		const name = rest.split('/')[0];
		const full = prefix + name;
		if (!name) {
			continue;
		}
		if (!seen.has(name)) {
			seen.set(name, { name, path: full, isDir: rest.includes('/'), ignored: IGNORED.includes(full) });
		}
	}
	if (dir && !seen.size && !EMPTY_DIRS.has(dir)) {
		throw { kind: 'error', message: `${dir} no longer exists` };
	}
	return [...seen.values()].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function demoReadFile(path: string): FileContent {
	const text = FILES.get(path);
	if (text === undefined) {
		throw { kind: 'error', message: `${path} no longer exists` };
	}
	return text === BINARY ? { text: '', binary: true, tooLarge: false, size: 48_211 } : { text, binary: false, tooLarge: false, size: text.length };
}

export function demoWriteFile(path: string, text: string): void {
	if (!FILES.has(path)) {
		throw { kind: 'error', message: `${path} is not a file` };
	}
	FILES.set(path, text);
}

const fail = (message: string): never => {
	throw { kind: 'error', message };
};
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const under = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
const exists = (path: string): boolean => FILES.has(path) || EMPTY_DIRS.has(path) || [...FILES.keys()].some((f) => f.startsWith(`${path}/`));

function freeName(dir: string, name: string, copy: boolean): string {
	const dot = name.lastIndexOf('.');
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	for (let n = copy ? 1 : 2; ; n++) {
		const candidate = copy ? (n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`) : `${stem} ${n}${ext}`;
		if (!exists(under(dir, candidate))) {
			return candidate;
		}
	}
}

/** Copy (or move) one entry, a file or a whole folder, to `to`. */
function carry(from: string, to: string, move: boolean): void {
	for (const [path, text] of [...FILES]) {
		if (path === from || path.startsWith(`${from}/`)) {
			FILES.set(to + path.slice(from.length), text);
			if (move) {
				FILES.delete(path);
			}
		}
	}
	for (const d of [...EMPTY_DIRS]) {
		if (d === from || d.startsWith(`${from}/`)) {
			EMPTY_DIRS.add(to + d.slice(from.length));
			if (move) {
				EMPTY_DIRS.delete(d);
			}
		}
	}
}

function remove(path: string): void {
	for (const f of [...FILES.keys()]) {
		if (f === path || f.startsWith(`${path}/`)) {
			FILES.delete(f);
		}
	}
	for (const d of [...EMPTY_DIRS]) {
		if (d === path || d.startsWith(`${path}/`)) {
			EMPTY_DIRS.delete(d);
		}
	}
	const parent = parentOf(path);
	if (parent && !exists(parent)) {
		EMPTY_DIRS.add(parent); // the folder stays, now empty
	}
}

function place(items: { from: string; name: string }[], to: string, onConflict: OnConflict, move: boolean): Placed {
	const taken = items.filter((i) => exists(under(to, i.name)) && under(to, i.name).toLowerCase() !== i.from.toLowerCase()).map((i) => i.name);
	if (onConflict === 'ask' && taken.length) {
		return { done: [], sources: [], conflicts: taken };
	}
	const done: string[] = [];
	const sources: string[] = [];
	for (const item of items) {
		let name = item.name;
		if (taken.includes(name)) {
			if (onConflict === 'skip') {
				continue;
			}
			if (onConflict === 'keep-both') {
				name = freeName(to, name, false);
			} else {
				remove(under(to, name));
			}
		}
		if (move) {
			EMPTY_DIRS.delete(under(to, name));
		}
		carry(item.from, under(to, name), move);
		if (move) {
			const parent = parentOf(item.from);
			if (parent && !exists(parent)) {
				EMPTY_DIRS.add(parent);
			}
		}
		done.push(under(to, name));
		sources.push(item.from);
	}
	return { done, sources, conflicts: [] };
}

/** The Files tab's create / move / duplicate / trash / import, on the demo tree. Dropped files arrive as made-up images. */
export function demoFileOp(cmd: string, args: Record<string, unknown>): unknown {
	const bad = (name: string) => !name.trim() || name === '.' || name === '..' || /[/\\:*?"<>|]/.test(name) || name.toLowerCase() === '.git';
	switch (cmd) {
		case 'files_create': {
			const dir = String(args.dir);
			const name = String(args.name);
			if (bad(name)) {
				fail(`"${name}" is not a usable name`);
			}
			const path = under(dir, name);
			if (exists(path)) {
				fail(`${name} already exists`);
			}
			if (args.isDir) {
				EMPTY_DIRS.add(path);
			} else {
				FILES.set(path, '');
			}
			EMPTY_DIRS.delete(dir);
			return path;
		}
		case 'files_move': {
			const paths = args.paths as string[];
			const to = String(args.to);
			const rename = args.rename ? String(args.rename) : null;
			if (rename !== null && bad(rename)) {
				fail(`"${rename}" is not a usable name`);
			}
			for (const p of paths) {
				if (to === p || to.startsWith(`${p}/`)) {
					fail(`${p} cannot be moved inside itself`);
				}
			}
			const items = paths.map((from) => ({ from, name: rename ?? nameOf(from) })).filter((i) => under(to, i.name) !== i.from);
			EMPTY_DIRS.delete(to);
			return place(items, to, args.onConflict as OnConflict, true);
		}
		case 'files_duplicate': {
			const path = String(args.path);
			const copy = under(parentOf(path), freeName(parentOf(path), nameOf(path), true));
			carry(path, copy, false);
			return copy;
		}
		case 'files_trash':
			for (const p of args.paths as string[]) {
				if (!exists(p)) {
					fail(`${p} no longer exists`);
				}
				remove(p);
			}
			return;
		case 'files_import': {
			const to = String(args.to);
			const items = (args.sources as string[]).map((source) => {
				const name = source.split(/[/\\]/).pop() ?? source;
				const from = `\u0000drop/${name}`;
				FILES.set(from, BINARY);
				return { from, name };
			});
			EMPTY_DIRS.delete(to);
			const placed = place(items, to, args.onConflict as OnConflict, true);
			for (const i of items) {
				FILES.delete(i.from);
			}
			return placed;
		}
	}
	return undefined;
}
