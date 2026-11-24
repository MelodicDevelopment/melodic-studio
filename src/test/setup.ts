/**
 * Runs before every spec file (vitest `setupFiles`).
 *
 * - The platform is pinned. happy-dom reports the machine it runs on, so without this `isMac()` and
 *   `isWindows()` would answer differently on each CI runner. Every spec starts as Linux (neither);
 *   one that is about the Mac or Windows spelling sets `navigator.platform` itself.
 * - Monaco never loads unless a spec brings its own fake (`vi.mock` in the spec wins over this one).
 *   `LspService` is made as soon as its module is imported and asks for Monaco on the Files tab, and
 *   the real one cannot run here: it used to fail in the background of whichever test came next.
 */
import { vi } from 'vitest';

Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });

vi.mock('../shared/monaco', async (original) => ({
	...(await original<Record<string, unknown>>()),
	loadMonaco: () => new Promise(() => {}),
}));

// Listeners the app puts on the window and the document are remembered, so `world()` can take the
// last app's away: a `focus` or `keydown` sent in one test must not reach the stores of the test before.
interface Kept {
	target: EventTarget;
	type: string;
	listener: EventListenerOrEventListenerObject | null;
	options?: boolean | AddEventListenerOptions;
}
const kept: Kept[] = [];
for (const target of [window, document] as EventTarget[]) {
	const add = target.addEventListener.bind(target);
	target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
		kept.push({ target, type, listener, options });
		add(type, listener, options);
	};
}

/** Takes away every window and document listener added since the last call. */
export function forgetListeners(): void {
	for (const k of kept.splice(0)) {
		k.target.removeEventListener(k.type, k.listener, k.options);
	}
}
(globalThis as { __forgetListeners?: () => void }).__forgetListeners = forgetListeners;
