/** Pull the first JSON object or array out of an answer (models like to wrap it in prose or a code fence). */
export function parseJson<T>(answer: string): T | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer)?.[1] ?? answer;
	const start = fenced.search(/[[{]/);
	if (start < 0) {
		return null;
	}
	const open = fenced[start];
	const end = fenced.lastIndexOf(open === '{' ? '}' : ']');
	try {
		return JSON.parse(fenced.slice(start, end + 1)) as T;
	} catch {
		return null;
	}
}
