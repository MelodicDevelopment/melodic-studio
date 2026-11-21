/**
 * The branch a new task works on, named after what the task says.
 *
 * Two sources. `branchFor` is instant and needs nothing: the task's own words with the filler taken
 * out. Claude's name (`branchNamePrompt` in ai-prompts.ts) replaces it for a task whose words do not
 * fit in a name, and `namedBranch` turns that answer into something git accepts.
 */

/** Words kept in a name made from the task's own. */
const MAX_WORDS = 4;
/** The longest name after the `agent/` prefix: it is also a folder name beside the repository. */
export const MAX_NAME = 40;

/** Words that say nothing about the work: how the request is phrased, not what it asks for. */
const FILLER = new Set(
	(
		'a an the this that these those it its is are was were be been being am do does did done doing ' +
		'can could would should shall will may might must lets let us we i me my you your our ' +
		'please kindly just also actually really basically simply currently right now instead rather ' +
		'of to in on at by for from with into onto over about as than then so and or but if when while where ' +
		'want wants wanted need needs needed like ' +
		'make makes sure some any there here which what who how why'
	).split(' ')
);

function wordsOf(task: string): string[] {
	return task
		.toLowerCase()
		// "I'd", "let's", "it's": the whole word is filler. Any other apostrophe just goes ("user's" -> users).
		.replace(/\b(?:i|we|you|they|it|he|she|that|there|let)['’](?:d|ll|ve|re|m|s)\b/g, ' ')
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean);
}

/** The words of a task that carry what it is about. A task of nothing but filler keeps its words. */
function telling(task: string): string[] {
	const words = wordsOf(task);
	const kept = words.filter((w) => !FILLER.has(w));
	return kept.length ? kept : words;
}

/** `words` joined with hyphens, cut at a word so it fits. */
function joined(words: string[]): string {
	let name = '';
	for (const w of words) {
		const next = name ? `${name}-${w}` : w;
		if (next.length > MAX_NAME) {
			break;
		}
		name = next;
	}
	// One word longer than the limit is cut where it stands.
	return name || (words[0] ?? '').slice(0, MAX_NAME);
}

/** A branch name from the words of a task that say something: "Can you fix the seek bug?" -> agent/fix-seek-bug. */
export function branchFor(task: string): string {
	const name = joined(telling(task).slice(0, MAX_WORDS));
	return name ? `agent/${name}` : '';
}

/**
 * Whether a task is worth asking Claude to name: only when its own words do not fit in a name,
 * so `branchFor` had to leave some out. "Fix the seek bug" is its own name.
 */
export function wantsNaming(task: string): boolean {
	return telling(task).length > MAX_WORDS;
}

/**
 * The branch in Claude's answer to `branchNamePrompt`, or null when it holds no name.
 * The answer is text from outside: only a-z, 0-9 and hyphens survive, under our own prefix.
 */
export function namedBranch(answer: string): string | null {
	const lines = answer
		.split(/\r?\n/)
		.map((l) => l.trim().replace(/^[`'"*\s]+|[`'"*.\s]+$/g, ''))
		.filter((l) => l && !/^(```|~~~)/.test(l));
	// The name alone on a line, as asked: with or without a prefix, hyphens or spaces between the words.
	let found = lines.map((l) => /^(?:[\w.-]+\/)*([A-Za-z0-9]+(?:[-_ ][A-Za-z0-9]+){0,5})$/.exec(l)?.[1]).find(Boolean);
	// Else the first hyphenated name in a sentence ("The branch name is fix-seek-bug.").
	found ??= /(?:^|[^A-Za-z0-9-])([a-z0-9]+(?:-[a-z0-9]+){1,5})(?![A-Za-z0-9-])/.exec(answer)?.[1];
	const name = found ? joined(wordsOf(found)) : '';
	return /[a-z]/.test(name) ? `agent/${name}` : null;
}
