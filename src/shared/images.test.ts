import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EDGE, MAX_IMAGE_BYTES, fitWithin, sendsAsIs, sniffImage } from './images.ts';

test('an image is known by its first bytes, not its name', () => {
	assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png');
	assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
	assert.equal(sniffImage(new TextEncoder().encode('GIF89a')), 'image/gif');
	assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
	assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ')), null, 'a sound file is a RIFF too');
	assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), null);
	assert.equal(sniffImage(new Uint8Array([])), null);
});

test('a large image is brought down by its longer side and keeps its shape', () => {
	assert.deepEqual(fitWithin(3024, 1964), { width: 2000, height: 1299 });
	assert.deepEqual(fitWithin(1000, 4000), { width: 500, height: 2000 });
	assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 }, 'never made larger');
	assert.deepEqual(fitWithin(MAX_EDGE, MAX_EDGE), { width: MAX_EDGE, height: MAX_EDGE });
	assert.deepEqual(fitWithin(30000, 2), { width: 2000, height: 1 }, 'a sliver keeps a pixel');
});

test('what goes as it is', () => {
	assert.equal(sendsAsIs('image/png', 200_000, 1440, 900), true);
	assert.equal(sendsAsIs('image/png', 200_000, 3024, 1964), false, 'too many pixels');
	assert.equal(sendsAsIs('image/jpeg', MAX_IMAGE_BYTES + 1, 800, 600), false, 'too many bytes');
	assert.equal(sendsAsIs('image/tiff', 1000, 10, 10), false, 'a kind Claude does not read');
	assert.equal(sendsAsIs(null, 1000, 10, 10), false);
});
