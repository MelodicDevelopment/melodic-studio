/**
 * What is at a point of the window, through shadow roots. Files dropped from outside arrive
 * from the window as a position, not as an event on an element, so whoever takes drops asks
 * whether the point is theirs: the element on top there, which a dialog over a pane settles.
 */

/** The innermost element at a point of the window, looking into shadow roots. */
export function elementAt(x: number, y: number): Element | null {
	let found = document.elementFromPoint(x, y);
	// A shadow root answers with its own innermost element, or with the element it was asked from.
	for (let depth = 0; found?.shadowRoot && depth < 32; depth++) {
		const inner = found.shadowRoot.elementFromPoint(x, y);
		if (!inner || inner === found) {
			break;
		}
		found = inner;
	}
	return found;
}

/** True when `node` is `zone` or inside it, however many shadow roots lie between. */
export function inside(node: Node | null, zone: Node): boolean {
	for (let n = node; n; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) {
		if (n === zone) {
			return true;
		}
	}
	return false;
}

/** True when the point is on `zone` and nothing lies over it there. */
export function hits(zone: Element | null, x: number, y: number): boolean {
	return !!zone && inside(elementAt(x, y), zone);
}
