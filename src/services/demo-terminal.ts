/**
 * The browser preview's stand-in for a shell: a line editor with a prompt and
 * a handful of commands, speaking the same commands and events as
 * src-tauri/src/terminal.rs so the terminal panel can be tried without Tauri.
 */

type Emit = (event: string, payload: unknown) => void;

interface DemoShell {
	cwd: string;
	line: string;
	/** A pretend Claude conversation rather than a shell. */
	claude?: { session: string; turns: number; asking?: boolean };
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
	if (shell.claude) {
		return '\x1b[2m> \x1b[0m';
	}
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

const demoHooks = new Map<string, (event: string, extra?: Record<string, unknown>) => void>();

/** A pretend turn: working, a subagent now and then, a question for the user every third turn, then an answer. */
function converse(key: string, shell: DemoShell, said: string, print: (text: string) => void): void {
	const hook = demoHooks.get(key);
	if (shell.claude!.asking) {
		shell.claude!.asking = false;
		const answer = said === '2' ? 'Understood, I left README.md alone.' : 'Done: README.md now has the new section.';
		print(`\r\n\x1b[38;5;173m●\x1b[0m ${answer}\r\n\r\n${prompt(shell)}`);
		hook?.('Stop', { text: answer });
		return;
	}
	const turn = ++shell.claude!.turns;
	print('\r\n\x1b[2m✻ Thinking…\x1b[0m\r\n');
	hook?.('UserPromptSubmit', { text: said });
	const subagent = turn % 2 === 0 ? `toolu_demo_${turn}` : null;
	if (subagent) {
		setTimeout(() => {
			print('\x1b[32m●\x1b[0m Agent(\x1b[1mLook around the code\x1b[0m)\r\n');
			hook?.('PreToolUse', { toolUseId: subagent, description: 'Look around the code', subagentType: 'Explore' });
		}, 600);
		setTimeout(() => hook?.('PostToolUse', { toolUseId: subagent, description: 'Look around the code', subagentType: 'Explore' }), 3200);
	}
	if (turn % 3 === 0) {
		setTimeout(() => {
			shell.claude!.asking = true;
			print(`\x1b[33mDo you want to make this edit to README.md?\x1b[0m  1. Yes  2. No\r\n${prompt(shell)}`);
			hook?.('Notification', { text: 'Claude needs your permission to use Edit', kind: 'permission_prompt' });
		}, 1500);
		return;
	}
	setTimeout(() => {
		if (!shells.has(key)) {
			return;
		}
		const answer = `In the browser preview there is no real Claude. You said: "${said}".`;
		print(`\x1b[38;5;173m●\x1b[0m ${answer}\r\n\r\n${prompt(shell)}`);
		hook?.('Stop', { text: answer });
	}, subagent ? 3600 : 1800);
}

/** Handles `term_open`, `term_write`, `term_resize` and `term_close` for the demo backend. */
export function demoTerminal(cmd: string, args: Record<string, unknown>, cwd: string, emit: Emit): unknown {
	const key = String(args.key);
	const print = (text: string): void => emit('term-data', { key, data: encode(text) });
	const shell = shells.get(key);

	if (cmd === 'claude_open') {
		const opened = `demo-claude-${++last}`;
		const fresh: DemoShell = { cwd: String(args.cwd ?? cwd), line: '', claude: { session: String(args.session), turns: 0 } };
		shells.set(opened, fresh);
		const hook = (event: string, extra: Record<string, unknown> = {}): void =>
			emit('claude-hook', { key: opened, event, sessionId: fresh.claude!.session, transcriptPath: null, text: null, kind: null, toolUseId: null, description: null, subagentType: null, ...extra });
		emit('term-data', {
			key: opened,
			data: encode(`\x1b[38;5;173m✻\x1b[0m \x1b[1mClaude Code\x1b[0m \x1b[2m(browser preview: a pretend conversation)\x1b[0m\r\n\x1b[2m${fresh.cwd}\x1b[0m\r\n\r\n${prompt(fresh)}`),
		});
		setTimeout(() => hook('SessionStart', { kind: args.resume ? 'resume' : 'startup' }), 50);
		demoHooks.set(opened, hook);
		return opened;
	}
	if (cmd === 'term_open') {
		const opened = `demo-term-${++last}`;
		const fresh: DemoShell = { cwd, line: '' };
		shells.set(opened, fresh);
		emit('term-data', { key: opened, data: encode(`\x1b[2mBrowser preview: a pretend shell. The desktop app runs your real one. Try \x1b[0mhelp\x1b[2m.\x1b[0m\r\n${prompt(fresh)}`) });
		return opened;
	}
	if (cmd === 'term_close') {
		shells.delete(key);
		demoHooks.delete(key);
		return;
	}
	if (cmd !== 'term_write' || !shell) {
		return;
	}
	// Escape sequences (arrow keys and the like) mean nothing to this shell.
	const typed = String(args.data).replace(/\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g, '');
	for (const ch of typed) {
		if ((ch === '\r' || ch === '\n') && shell.claude) {
			const said = shell.line.trim();
			shell.line = '';
			if (!said) {
				print(`\r\n${prompt(shell)}`);
				continue;
			}
			if (said === '/exit') {
				print('\r\n');
				shells.delete(key);
				emit('term-exit', { key, code: 0 });
				return;
			}
			converse(key, shell, said, print);
		} else if (ch === '\r' || ch === '\n') {
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
