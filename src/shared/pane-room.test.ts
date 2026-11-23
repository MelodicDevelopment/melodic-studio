import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIVIDER_W, MIN_MAIN_DRAG_W, MIN_MAIN_W, MIN_SIDE_W, maxDragSide, maxSide, sideFits, sideWidth } from './pane-room.ts';

test('a new pane takes a third of the window', () => {
	assert.equal(sideWidth(null, 2100, 2400), 800);
});

test('without a drag the main pane keeps its full floor', () => {
	for (const room of [1161, 1199, 1600, 2100]) {
		const side = sideWidth(null, room, 1500);
		assert.ok(room - DIVIDER_W - side >= MIN_MAIN_W, `main pane in ${room}`);
	}
});

test('a drag may take the main pane down to the drag floor, no further', () => {
	const room = 1600;
	assert.equal(sideWidth(5000, room, 1900), room - MIN_MAIN_DRAG_W - DIVIDER_W);
	assert.equal(room - DIVIDER_W - sideWidth(5000, room, 1900), MIN_MAIN_DRAG_W);
	assert.equal(sideWidth(maxDragSide(room), room, 1900), maxDragSide(room));
	assert.equal(sideWidth(maxDragSide(room) + 1, room, 1900), maxDragSide(room));
});

test('a drag between the two floors is kept as dragged', () => {
	const room = 1600;
	const side = 1099; // leaves 500 px: under the default floor, over the drag floor
	assert.ok(room - DIVIDER_W - side < MIN_MAIN_W);
	assert.equal(sideWidth(side, room, 1900), side);
});

test('a dragged width is kept while it leaves the main pane its floor', () => {
	assert.equal(sideWidth(400, 1600, 1900), 400);
	assert.equal(sideWidth(100, 1600, 1900), MIN_SIDE_W);
});

test('the drag range is never inverted in a room that barely fits both', () => {
	const room = MIN_MAIN_W + DIVIDER_W + MIN_SIDE_W;
	assert.ok(maxDragSide(room) >= MIN_SIDE_W);
	assert.equal(sideWidth(0, room, 1500), MIN_SIDE_W);
	assert.equal(sideWidth(5000, room, 1500), maxDragSide(room));
	// A room too small for both: the width is still the pane's own minimum, never negative.
	assert.equal(sideWidth(5000, 300, 1500), MIN_SIDE_W);
});

test('the drag floor is lower than the default floor', () => {
	assert.ok(MIN_MAIN_DRAG_W < MIN_MAIN_W);
	assert.equal(maxDragSide(1199), 1199 - MIN_MAIN_DRAG_W - DIVIDER_W);
});

test('the pane is not shown when it would be squeezed', () => {
	assert.equal(sideFits(MIN_MAIN_W + DIVIDER_W + MIN_SIDE_W), true);
	assert.equal(sideFits(MIN_MAIN_W + DIVIDER_W + MIN_SIDE_W - 1), false);
	assert.equal(sideFits(799), false); // a 1100 px window with a 300 px sidebar
	assert.equal(maxSide(1199), 1199 - MIN_MAIN_W - DIVIDER_W);
});
