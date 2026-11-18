/**
 * The part of `.editorconfig` (https://editorconfig.org) the editor uses: indentation, trimming, the final
 * newline and a line-length ruler. Only the repository root's file is read; sections are matched with the
 * spec's globs (`*`, `**`, `?`, `[abc]`, `{a,b}`), later sections overriding earlier ones.
 */

export interface EditorConfig {
	indentStyle?: 'space' | 'tab';
	indentSize?: number;
	tabWidth?: number;
	trimTrailingWhitespace?: boolean;
	insertFinalNewline?: boolean;
	maxLineLength?: number;
}

interface Section {
	glob: RegExp;
	props: Record<string, string>;
}

export interface ParsedEditorConfig {
	sections: Section[];
}

/** An editorconfig glob as a regular expression over a repository-relative path. */
export function globToRegExp(glob: string): RegExp {
	// A pattern without `/` matches a file name at any depth.
	const anywhere = !glob.includes('/');
	const pattern = glob.replace(/^\//, '');
	let out = '';
	let braces = 0;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				out += '.*';
				i++;
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else if (c === '[') {
			const end = pattern.indexOf(']', i);
			if (end < 0) {
				out += '\\[';
			} else {
				const body = pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
				out += `[${body}]`;
				i = end;
			}
		} else if (c === '{') {
			braces++;
			out += '(?:';
		} else if (c === '}' && braces) {
			braces--;
			out += ')';
		} else if (c === ',' && braces) {
			out += '|';
		} else {
			out += c.replace(/[.+^$()|\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${out}$`);
}

export function parseEditorConfig(text: string): ParsedEditorConfig {
	const sections: Section[] = [];
	let current: Section | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) {
			continue;
		}
		const header = /^\[(.*)\]$/.exec(line);
		if (header) {
			try {
				current = { glob: globToRegExp(header[1].trim()), props: {} };
				sections.push(current);
			} catch {
				current = null; // a glob we cannot read: skip its section
			}
			continue;
		}
		const eq = line.indexOf('=');
		if (current && eq > 0) {
			current.props[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim().toLowerCase();
		}
	}
	return { sections };
}

/** The settings for one repository-relative path. */
export function editorConfigFor(config: ParsedEditorConfig, path: string): EditorConfig {
	const props: Record<string, string> = {};
	for (const s of config.sections) {
		if (s.glob.test(path)) {
			Object.assign(props, s.props);
		}
	}
	const num = (v: string | undefined) => (v && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined);
	const bool = (v: string | undefined) => (v === 'true' ? true : v === 'false' ? false : undefined);
	const out: EditorConfig = {};
	if (props.indent_style === 'space' || props.indent_style === 'tab') {
		out.indentStyle = props.indent_style;
	}
	out.tabWidth = num(props.tab_width);
	out.indentSize = props.indent_size === 'tab' ? out.tabWidth : (num(props.indent_size) ?? (out.indentStyle === 'tab' ? out.tabWidth : undefined));
	out.trimTrailingWhitespace = bool(props.trim_trailing_whitespace);
	out.insertFinalNewline = bool(props.insert_final_newline);
	out.maxLineLength = num(props.max_line_length);
	return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as EditorConfig;
}

/** Text with spaces and tabs at line ends removed and/or exactly one newline at the end, keeping its line endings. */
export function tidy(text: string, trim: boolean, finalNewline: boolean): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	let out = trim ? text.replace(/[ \t]+(?=\r?\n|$)/g, '') : text;
	if (finalNewline && out.length && !out.endsWith('\n')) {
		out += eol;
	}
	return out;
}
