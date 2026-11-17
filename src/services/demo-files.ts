/**
 * The demo repository's working tree, for the Files tab in the browser preview.
 * Kept apart from the demo backend so that file only gains three `case` lines.
 */
import type { FileContent, TreeEntry } from './backend.service';

const BINARY = '\u0000binary';

const IGNORED = ['node_modules', 'dist', 'debug.log'];

const FILES = new Map<string, string>([
	['.gitignore', 'node_modules/\ndist/\n*.log\n'],
	['README.md', '# harmony\n\nA small music player.\n\n## Develop\n\n```sh\nnpm install\nnpm run dev\n```\n'],
	['package.json', '{\n\t"name": "harmony",\n\t"version": "1.4.0",\n\t"type": "module",\n\t"scripts": {\n\t\t"dev": "vite",\n\t\t"build": "tsc --noEmit && vite build"\n\t}\n}\n'],
	['debug.log', 'queue: wrapped at 12\n'],
	['public/cover.png', BINARY],
	['public/index.html', '<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="UTF-8" />\n\t\t<title>Harmony</title>\n\t</head>\n\t<body>\n\t\t<div id="app"></div>\n\t</body>\n</html>\n'],
	['docs/shortcuts.md', '# Keyboard shortcuts\n\n| Key | Action |\n| --- | --- |\n| Space | Play / pause |\n| R | Cycle repeat mode |\n'],
	['src/main.ts', "import { Queue } from './player/queue';\nimport { nextRepeatMode, type RepeatMode } from './player/repeat';\n\nconst queue = new Queue();\nlet repeat: RepeatMode = 'off';\n\ndocument.addEventListener('keydown', (e) => {\n\tif (e.key === 'r') {\n\t\trepeat = nextRepeatMode(repeat);\n\t}\n\tif (e.key === 'ArrowRight') {\n\t\tqueue.next(repeat !== 'off');\n\t}\n});\n"],
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

export function demoListDir(dir: string): TreeEntry[] {
	const prefix = dir ? `${dir}/` : '';
	const seen = new Map<string, TreeEntry>();
	for (const path of FILES.keys()) {
		if (!path.startsWith(prefix)) {
			continue;
		}
		const rest = path.slice(prefix.length);
		const name = rest.split('/')[0];
		const full = prefix + name;
		if (!seen.has(name)) {
			seen.set(name, { name, path: full, isDir: rest.includes('/'), ignored: IGNORED.includes(full) });
		}
	}
	if (dir && !seen.size) {
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
