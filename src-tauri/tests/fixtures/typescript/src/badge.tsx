import { greet } from './greeter';

declare global {
	namespace JSX {
		interface IntrinsicElements {
			span: { title?: string };
		}
	}
}

export function badge(name: string) {
	const label = greet(name);
	return <span title={label}></span>;
}
