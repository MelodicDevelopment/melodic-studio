/**
 * Images attached to a message for Claude: which kinds it reads, how large one may be, and
 * what an oversized one is brought down to. The decoding and drawing are the browser's
 * (`services/agent-images.ts`); this is the arithmetic, which Node can test.
 */

/** The four kinds Claude reads, with the extension a stored one gets (`history.rs` knows the same four). */
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** One image as bytes. The API takes 5 MB of base64, which is 3.75 MB of image (`MAX_IMAGE` in history.rs). */
export const MAX_IMAGE_BYTES = 3_700_000;
/** The longer side, in pixels. Above about 1,600 the API scales an image down itself; a message with many images refuses any over 2,000. */
export const MAX_EDGE = 2000;
/** Images in one message. */
export const MAX_IMAGES = 10;

/** What the bytes are, whatever the file is called: a `.png` from a phone is often a JPEG. Null for anything Claude does not read. */
export function sniffImage(bytes: Uint8Array): string | null {
	const starts = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
	if (starts(0x89, 0x50, 0x4e, 0x47)) {
		return 'image/png';
	}
	if (starts(0xff, 0xd8, 0xff)) {
		return 'image/jpeg';
	}
	if (starts(0x47, 0x49, 0x46, 0x38)) {
		return 'image/gif';
	}
	if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		return 'image/webp';
	}
	return null;
}

/** The size an image is drawn at so that its longer side is at most `max`. Never larger than it is, never under one pixel. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
	const scale = Math.min(1, max / Math.max(width, height, 1));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** True when an image can go as it is: a kind Claude reads, small enough in bytes and in pixels. */
export function sendsAsIs(type: string | null, bytes: number, width: number, height: number): boolean {
	return !!type && type in IMAGE_TYPES && bytes <= MAX_IMAGE_BYTES && Math.max(width, height) <= MAX_EDGE;
}
