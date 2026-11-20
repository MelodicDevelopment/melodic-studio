/**
 * Making an image ready to send to Claude: one that is already a PNG, JPEG, GIF or WebP of a
 * reasonable size goes as it is; anything else the web view can decode (a full-screen Retina
 * screenshot, a TIFF, a HEIC where the system reads those) is drawn smaller and encoded again.
 * The limits and the arithmetic are in shared/images.ts.
 */
import { IMAGE_TYPES, MAX_IMAGE_BYTES, fitWithin, sendsAsIs, sniffImage } from '../shared/images';

/** An image waiting in a composer, or one just sent. */
export interface Attachment {
	/** Its file name in the session's folder once sent: ours, never the user's. */
	name: string;
	mediaType: string;
	/** The image in base64. */
	data: string;
	/** The same as a `data:` address, for an `<img>` (the app's content policy allows no `blob:`). */
	url: string;
}

function dataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('The image could not be read'));
		reader.readAsDataURL(blob);
	});
}

function encode(image: ImageBitmap, size: { width: number; height: number }, type: string, quality?: number): Promise<Blob | null> {
	const canvas = document.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return Promise.resolve(null);
	}
	if (type === 'image/jpeg') {
		// A JPEG has no transparency: what was see-through would come out black.
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, size.width, size.height);
	}
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(image, 0, 0, size.width, size.height);
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Rejects with a sentence for the user when the file is not an image, or cannot be made small enough. */
export async function prepareImage(file: Blob): Promise<Attachment> {
	const actual = sniffImage(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
	let image: ImageBitmap;
	try {
		image = await createImageBitmap(file);
	} catch {
		throw new Error('That is not an image this computer can read. PNG, JPEG, GIF and WebP always work.');
	}
	let blob: Blob | null = actual ? file.slice(0, file.size, actual) : null;
	try {
		if (!blob || !sendsAsIs(actual, file.size, image.width, image.height)) {
			const size = fitWithin(image.width, image.height);
			blob = await encode(image, size, 'image/png');
			if (!blob || blob.size > MAX_IMAGE_BYTES) {
				blob = await encode(image, size, 'image/jpeg', 0.85);
			}
			if (!blob || blob.size > MAX_IMAGE_BYTES || !(blob.type in IMAGE_TYPES)) {
				throw new Error('That image is too large to send, even made smaller.');
			}
		}
	} finally {
		image.close();
	}
	const url = await dataUrl(blob);
	return { name: `${crypto.randomUUID()}.${IMAGE_TYPES[blob.type]}`, mediaType: blob.type, data: url.slice(url.indexOf(',') + 1), url };
}

/** The images among what was pasted or dropped (a screenshot on the clipboard is a file with no name worth keeping). */
export function imagesIn(transfer: DataTransfer | null): File[] {
	let files = [...(transfer?.files ?? [])];
	if (!files.length) {
		// Some web views list a pasted image only among the items.
		files = [...(transfer?.items ?? [])].map((item) => (item.kind === 'file' ? item.getAsFile() : null)).filter((f): f is File => !!f);
	}
	return files.filter((f) => f.type.startsWith('image/'));
}
