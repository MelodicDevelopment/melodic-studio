/** Builds the line the fixture prints. */
export function greet(name: string): string {
	return `Hello, ${name}!`;
}

export interface Visitor {
	name: string;
	visits: number;
}
