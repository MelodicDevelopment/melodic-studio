/**
 * Putting a real component on the page of a test and looking into it. Call `world()` first, then
 * `await import('../../components')` (it registers every element), then set the stores up.
 */
import { settle } from './world';

/** Adds `<tag>` to the page with the given properties and waits for it to render. */
export async function mount<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}): Promise<T> {
	const el = document.createElement(tag) as T;
	Object.assign(el, props);
	document.body.append(el);
	await settle();
	return el;
}

/** Everything under `root` that matches, through every shadow root on the way down. */
export function all<T extends Element = HTMLElement>(root: Element | ShadowRoot | Document, selector: string): T[] {
	const found: T[] = [...root.querySelectorAll<T>(selector)];
	const hosts = [...root.querySelectorAll('*')].filter((e) => e.shadowRoot);
	if ('shadowRoot' in root && root.shadowRoot) {
		found.push(...all<T>(root.shadowRoot, selector));
	}
	for (const host of hosts) {
		found.push(...all<T>(host.shadowRoot!, selector));
	}
	return [...new Set(found)];
}

/** The first match, or null. */
export function find<T extends Element = HTMLElement>(root: Element | ShadowRoot | Document, selector: string): T | null {
	return all<T>(root, selector)[0] ?? null;
}

/** The text a person would read under `root`, shadow roots included, spaces collapsed. Styles are left out. */
export function text(root: Element | ShadowRoot | Document): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
			return;
		}
		if (node instanceof Element) {
			if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') {
				return;
			}
			if (node.shadowRoot) {
				walk(node.shadowRoot);
			}
		}
		node.childNodes.forEach(walk);
	};
	walk(root);
	return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The element whose own text is `label` (a button, a row), or null. */
export function labelled<T extends Element = HTMLElement>(root: Element | ShadowRoot | Document, selector: string, label: string | RegExp): T | null {
	return all<T>(root, selector).find((e) => (typeof label === 'string' ? text(e) === label : label.test(text(e)))) ?? null;
}

/** A click as a person makes it, then time for the page to follow. */
export async function click(el: Element | null): Promise<void> {
	if (!el) {
		throw new Error('nothing to click');
	}
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
	await settle();
}
