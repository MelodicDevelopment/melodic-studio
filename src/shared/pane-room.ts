/**
 * How the main pane and the Claude pane share the width beside the sidebar.
 * The main pane is never the narrow one: it keeps `MIN_MAIN_W`, and when the
 * window cannot give it that with a usable Claude pane beside it, the Claude
 * pane is not shown at all (it waits behind its toolbar button).
 */

/**
 * What the main pane keeps while the Claude pane is beside it: 100 columns of code at the editor's
 * default text size (measured: 63 px of line numbers and folding, 7.4 px a column, 16 px of scrollbar),
 * with the minimap out of the way (the editor drops it when it is this narrow).
 */
export const MIN_MAIN_W = 840;
/**
 * What the main pane keeps while the user drags the separator. Lower than `MIN_MAIN_W` on purpose:
 * 840 is what a pane gets by itself and what decides whether both fit, but a person who drags the
 * edge has chosen, and may want the Claude pane much wider.
 */
export const MIN_MAIN_DRAG_W = 360;
/** Narrower than this a terminal is not worth showing. */
export const MIN_SIDE_W = 320;
/** The line between the two panes. */
export const DIVIDER_W = 1;

/** The widest the Claude pane may be in `room` (the width the two panes share) without a drag. */
export function maxSide(room: number): number {
	return room - MIN_MAIN_W - DIVIDER_W;
}

/** The widest the Claude pane may be dragged in `room`: the main pane keeps `MIN_MAIN_DRAG_W`. */
export function maxDragSide(room: number): number {
	return room - MIN_MAIN_DRAG_W - DIVIDER_W;
}

/**
 * Whether both panes fit side by side at the default width. Deliberately judged by the full
 * `MIN_MAIN_W` floor and not by the drag floor: in a narrower window the Claude pane waits behind
 * its button rather than squeezing the main pane, and the lower drag floor is only for a pane
 * that is on screen.
 */
export function sideFits(room: number): boolean {
	return maxSide(room) >= MIN_SIDE_W;
}

/**
 * The Claude pane's width: what the user dragged it to, else a third of the window.
 * A third of the window never takes the main pane under `MIN_MAIN_W`; a dragged width
 * may, down to `MIN_MAIN_DRAG_W`.
 */
export function sideWidth(dragged: number | null, room: number, windowWidth: number): number {
	const limit = dragged === null ? maxSide(room) : maxDragSide(room);
	const wanted = dragged ?? Math.round(windowWidth / 3);
	return Math.max(MIN_SIDE_W, Math.min(wanted, limit));
}
