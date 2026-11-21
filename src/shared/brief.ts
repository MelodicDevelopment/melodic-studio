/**
 * A task agent's brief: the few lines that say where it stands, so several agents can be
 * followed without reading their replies. Claude Code is told to end every turn with a
 * fenced block (`BRIEF_RULES` in src-tauri/src/agent.rs, passed as `--append-system-prompt`):
 *
 *     ```brief
 *     title: Review opens the wrong checkout
 *     did: Review now waits for the switch to the session's checkout.
 *     needs: nothing
 *     ```
 *
 * with `choice:` lines when `needs` is a question with obvious answers. The block is taken
 * out of the reply (`parseBrief`); what a list shows comes from `summaryOf`, which falls back
 * to the transcript when a turn ended without one. Everything here is text from Claude: text
 * bindings only.
 */

export interface Brief {
	/** A name for the whole task, a few words. */
	title: string;
	/** What the turn did or found, one sentence. */
	did: string;
	/** What the user must do or decide next; null for nothing. */
	needs: string | null;
	/** Short answers to `needs`, when it is a question that has obvious ones. Sent as they are. */
	choices: string[];
}

const MAX_TITLE = 60;
const MAX_LINE = 280;
const MAX_CHOICE = 60;
const MAX_CHOICES = 3;

/** A message as one line of plain text, for previews: no Markdown, no code blocks, cut at `max`. */
export function plainSummary(text: string, max = 220): string {
	const flat = text
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		.replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_~`]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** "nothing", "None.", "-", "n/a": the user needs to do nothing. */
const NOTHING = /^(nothing|none|no|n\/a|-+|—)\.?$/i;

/** A fenced block of a reply, by character offsets. `end` is where its closing fence ends (or the text does). */
interface Block {
	start: number;
	bodyStart: number;
	bodyEnd: number;
	end: number;
	info: string;
}

/** The fenced code blocks of a Markdown text, in order. One left open runs to the end. */
function blocks(text: string): Block[] {
	const out: Block[] = [];
	const line = /[^\n]*(\n|$)/g;
	let open: { start: number; bodyStart: number; char: string; size: number; info: string } | null = null;
	for (let m = line.exec(text); m && m[0]; m = line.exec(text)) {
		const fence = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^\n]*?\r?\n?$/.exec(m[0]);
		if (!open) {
			if (fence) {
				open = { start: m.index, bodyStart: m.index + m[0].length, char: fence[1][0], size: fence[1].length, info: fence[2].toLowerCase() };
			}
		} else if (fence && fence[1][0] === open.char && fence[1].length >= open.size && !fence[2]) {
			out.push({ start: open.start, bodyStart: open.bodyStart, bodyEnd: m.index, end: m.index + m[0].length, info: open.info });
			open = null;
		}
	}
	if (open) {
		out.push({ start: open.start, bodyStart: open.bodyStart, bodyEnd: text.length, end: text.length, info: open.info });
	}
	return out;
}

/** Info strings a model writes when it forgets to say `brief`. Such a block counts only when it ends the reply. */
const LOOSE_INFO = new Set(['', 'text', 'txt', 'plaintext', 'yaml', 'yml', 'md', 'markdown']);

/**
 * Take the brief out of a reply: the last ```brief block, else a plain fenced block that ends the
 * reply (Claude sometimes writes ```text), as long as it has `did` or `needs`. One that is not
 * closed counts when it runs to the end (a turn can end mid-block). Otherwise the text is left as it is.
 */
export function parseBrief(text: string): { brief: Brief | null; rest: string } {
	const all = blocks(text);
	const last = all[all.length - 1];
	const block = [...all].reverse().find((b) => b.info === 'brief') ?? (last && LOOSE_INFO.has(last.info) && !text.slice(last.end).trim() ? last : undefined);
	if (!block) {
		return { brief: null, rest: text };
	}
	const fields: Record<string, string> = {};
	const choices: string[] = [];
	for (const raw of text.slice(block.bodyStart, block.bodyEnd).split(/\r?\n/)) {
		const m = /^\s*[-*]?\s*(title|did|needs|choice)\s*:\s*(.*)$/i.exec(raw);
		if (!m) {
			continue;
		}
		const key = m[1].toLowerCase();
		const value = plainSummary(m[2], key === 'title' ? MAX_TITLE : key === 'choice' ? MAX_CHOICE : MAX_LINE);
		if (!value) {
			continue;
		}
		if (key === 'choice') {
			if (choices.length < MAX_CHOICES && !choices.includes(value)) {
				choices.push(value);
			}
		} else {
			fields[key] = value;
		}
	}
	if (!fields.did && !fields.needs) {
		return { brief: null, rest: text };
	}
	const needs = !fields.needs || NOTHING.test(fields.needs) ? null : fields.needs;
	return {
		brief: { title: fields.title ?? '', did: fields.did ?? '', needs, choices: needs ? choices : [] },
		rest: [text.slice(0, block.start).replace(/\s+$/, ''), text.slice(block.end).replace(/^\s*\n/, '').replace(/\s+$/, '')].filter(Boolean).join('\n'),
	};
}

/** What `summaryOf` needs of a transcript item (AgentItem in agents.store.ts). */
export interface BriefItem {
	kind: 'user' | 'text' | 'tool' | 'error';
	text: string;
	detail?: string;
	/** For a Bash call: Claude's own words for what the command does. */
	about?: string;
}

/** The last part or two of a path: "src/services/agents.store.ts" -> "services/agents.store.ts". */
function shortPath(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.slice(-2).join('/') || path;
}

/** A tool call in words: "Editing services/agents.store.ts", "Run the unit tests". */
export function toolWords(item: BriefItem): string {
	const detail = item.detail ?? '';
	switch (item.text) {
		case 'Read':
			return detail ? `Reading ${shortPath(detail)}` : 'Reading';
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
		case 'NotebookEdit':
			return detail ? `Editing ${shortPath(detail)}` : 'Editing';
		case 'Bash':
			return item.about ? item.about : detail ? `Running ${plainSummary(detail, 80)}` : 'Running a command';
		case 'Grep':
			return detail ? `Searching for ${plainSummary(detail, 60)}` : 'Searching';
		case 'Glob':
			return detail ? `Looking for ${plainSummary(detail, 60)}` : 'Looking for files';
		case 'WebFetch':
		case 'WebSearch':
			return detail ? `Looking up ${plainSummary(detail, 80)}` : 'Looking it up';
		case 'Task':
		case 'Agent':
			return detail ? `Subagent: ${plainSummary(detail, 80)}` : 'Running a subagent';
		default:
			return detail ? `${item.text}: ${plainSummary(detail, 80)}` : item.text;
	}
}

/** What a running turn is doing: its latest step, in words. */
export function activity(items: readonly BriefItem[]): string {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			break;
		}
		if (item.kind === 'tool') {
			return toolWords(item);
		}
		if (item.kind === 'text' && item.text.trim()) {
			return plainSummary(item.text, 140);
		}
	}
	return 'Starting';
}

/** The last message the user sent, as one line. */
export function lastAsked(items: readonly BriefItem[]): string {
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].kind === 'user') {
			return plainSummary(items[i].text, 180);
		}
	}
	return '';
}

/** The last thing said in the latest turn (or what went wrong), as one line. */
function lastReply(items: readonly BriefItem[]): string {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'user') {
			break;
		}
		if ((item.kind === 'text' || item.kind === 'error') && item.text.trim()) {
			return plainSummary(item.text, 180);
		}
	}
	return '';
}

/** How a session stands, as much as `summaryOf` needs to know. */
export interface Standing {
	kind: 'task' | 'ask' | 'investigate';
	running: boolean;
	failed: boolean;
	stopped: boolean;
	/** Work to review (AgentSession.review). */
	review: boolean;
	/** It ended while nobody was looking. */
	unread: boolean;
	/** It has a worktree of its own, so its work is merged from there. */
	isolated: boolean;
	/** An investigation waiting for an OK: what it wants to run. */
	approval: string | null;
	brief: Brief | null;
	items: readonly BriefItem[];
}

/** The three lines a list shows for a session. `now` is set while it runs, `did` once it has stopped. */
export interface Summary {
	asked: string;
	now: string | null;
	did: string;
	needs: string | null;
	choices: string[];
}

/** Where a session stands, from its brief, or from the transcript when the turn left none. */
export function summaryOf(s: Standing): Summary {
	const asked = lastAsked(s.items);
	if (s.approval) {
		return { asked, now: null, did: s.brief?.did ?? '', needs: `Wants to run ${s.approval}`, choices: [] };
	}
	if (s.running) {
		return { asked, now: activity(s.items), did: '', needs: null, choices: [] };
	}
	const reply = lastReply(s.items);
	if (s.failed) {
		return { asked, now: null, did: reply || 'It stopped with an error.', needs: 'It failed: read what went wrong', choices: [] };
	}
	if (s.stopped) {
		return { asked, now: null, did: s.brief?.did || 'Stopped by hand.', needs: null, choices: [] };
	}
	const did = s.brief?.did || reply;
	// A question it asked says more than "review": it comes first.
	let needs = s.brief?.needs ?? null;
	if (!needs && s.review) {
		needs = s.isolated ? 'Review its changes, then merge' : 'Review its changes';
	}
	if (!needs && s.unread) {
		needs = s.kind === 'ask' ? 'Read the answer' : 'Read its reply';
	}
	return { asked, now: null, did, needs, choices: s.brief?.needs ? s.brief.choices : [] };
}

/** How many words a stretch of replies holds, for "Full reply · 420 words". */
export function wordCount(texts: readonly string[]): number {
	return texts.reduce((n, t) => n + (t.match(/\S+/g)?.length ?? 0), 0);
}
