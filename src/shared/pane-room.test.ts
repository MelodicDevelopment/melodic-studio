import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIVIDER_W, MIN_MAIN_W, MIN_SIDE_W, maxSide, sideFits, sideWidth } from './pane-room.ts';

test('a new pane takes a third of the window', () => {
	assert.equal(sideWidth(null, 2100, 2400), 800);
});

test('the main pane keeps its floor whatever was asked for', () => {
	const room = 1199; // a 1500 px window with a 300 px sidebar
	for (const dragged of [null, 640, 5000]) {
		const side = sideWidth(dragged, room, 1500);
		assert.ok(room - DIVIDER_W - side >= MIN_MAIN_W, `main pane with ${dragged}`);
	}
});

test('a dragged width is kept while it leaves the main pane its floor', () => {
	assert.equal(sideWidth(400, 1600, 1900), 400);
	assert.equal(sideWidth(100, 1600, 1900), MIN_SIDE_W);
});

test('the pane is not shown when it would be squeezed', () => {
	assert.equal(sideFits(MIN_MAIN_W + DIVIDER_W + MIN_SIDE_W), true);
	assert.equal(sideFits(MIN_MAIN_W + DIVIDER_W + MIN_SIDE_W - 1), false);
	assert.equal(sideFits(799), false); // a 1100 px window with a 300 px sidebar
	assert.equal(maxSide(1199), 1199 - MIN_MAIN_W - DIVIDER_W);
});
