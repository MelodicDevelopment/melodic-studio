/**
 * The browser preview's stand-in for a shell: a line editor with a prompt and
 * a handful of commands, speaking the same commands and events as
 * src-tauri/src/terminal.rs so the terminal panel can be tried without Tauri.
 */

type Emit = (event: string, payload: unknown) => void;

interface DemoShell {
	cwd: string;
	line: string;
}

const shells = new Map<string, DemoShell>();
let last = 0;

/** Base64 of the UTF-8 bytes, as the native side sends terminal output. */
function encode(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function folder(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function prompt(shell: DemoShell): string {
	return `\x1b[32m${folder(shell.cwd)}\x1b[0m \x1b[34m$\x1b[0m `;
}

/** What a command prints, or null when it ends the shell. */
function run(shell: DemoShell, line: string): string | null {
	const [name, ...rest] = line.trim().split(/\s+/);
	switch (name) {
		case '':
			return '';
		case 'echo':
			return `${rest.join(' ')}\r\n`;
		case 'pwd':
			return `${shell.cwd}\r\n`;
		case 'ls':
			return '\x1b[34mdocs\x1b[0m  \x1b[34mpublic\x1b[0m  \x1b[34msrc\x1b[0m  package.json  README.md\r\n';
		case 'date':
			return `${new Date().toString()}\r\n`;
		case 'clear':
			return '\x1b[2J\x1b[H';
		case 'help':
			return 'Commands in this preview: echo, pwd, ls, date, clear, exit.\r\n';
		case 'exit':
			return null;
		default:
			return `demo: command not found: ${name}\r\n`;
	}
}

/** Handles `term_open`, `term_write`, `term_resize` and `term_close` for the demo backend. */
export function demoTerminal(cmd: string, args: Record<string, unknown>, cwd: string, emit: Emit): unknown {
	const key = String(args.key);
	const print = (text: string): void => emit('term-data', { key, data: encode(text) });
	const shell = shells.get(key);

	if (cmd === 'term_open') {
		const opened = `demo-term-${++last}`;
		const fresh: DemoShell = { cwd, line: '' };
		shells.set(opened, fresh);
		emit('term-data', { key: opened, data: encode(`\x1b[2mBrowser preview: a pretend shell. The desktop app runs your real one. Try \x1b[0mhelp\x1b[2m.\x1b[0m\r\n${prompt(fresh)}`) });
		return opened;
	}
	if (cmd === 'term_close') {
		shells.delete(key);
		return;
	}
	if (cmd !== 'term_write' || !shell) {
		return;
	}
	// Escape sequences (arrow keys and the like) mean nothing to this shell.
	const typed = String(args.data).replace(/\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g, '');
	for (const ch of typed) {
		if (ch === '\r' || ch === '\n') {
			const out = run(shell, shell.line);
			shell.line = '';
			if (out === null) {
				print('\r\n');
				shells.delete(key);
				emit('term-exit', { key, code: 0 });
				return;
			}
			print(`\r\n${out}${prompt(shell)}`);
		} else if (ch === '\x7f' || ch === '\b') {
			if (shell.line) {
				shell.line = [...shell.line].slice(0, -1).join('');
				print('\b \b');
			}
		} else if (ch === '\x03') {
			shell.line = '';
			print(`^C\r\n${prompt(shell)}`);
		} else if (ch === '\x0c') {
			print(`\x1b[2J\x1b[H${prompt(shell)}${shell.line}`);
		} else if (ch >= ' ') {
			shell.line += ch;
			print(ch);
		}
	}
}
