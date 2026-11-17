/**
 * The three web views the app runs in (WKWebView on macOS, WebView2 on Windows,
 * WebKitGTK on Linux) are browsers first. This is where the app checks that the one
 * it got is new enough, and switches off the browser habits a desktop window should
 * not have.
 */
import { isDesktop, isMac, isWindows } from '../services/backend.service';

/**
 * Null when the web view can run the app, else what the user should do about it.
 * The toolbar's menus are HTML popovers (Safari 17, Chromium 114, WebKitGTK 2.42);
 * without them nothing in the toolbar opens, so say so instead of looking broken.
 */
export function webviewProblem(): string | null {
	if (typeof HTMLElement === 'undefined' || 'showPopover' in HTMLElement.prototype) {
		return null;
	}
	if (isMac()) {
		return 'Melodic Studio needs macOS 14 (Sonoma) or later. This version of macOS has an older web view than the app can use.';
	}
	if (isWindows()) {
		return 'Melodic Studio needs a newer Microsoft Edge WebView2 Runtime (version 114 or later). Install the current one from Microsoft, then start Melodic Studio again.';
	}
	return 'Melodic Studio needs WebKitGTK 2.42 or later. Update the webkit2gtk-4.1 package (libwebkit2gtk-4.1-0 on Debian and Ubuntu), then start Melodic Studio again.';
}

/** Put a plain message where the app would have been. */
function showProblem(target: string, message: string): void {
	const box = document.createElement('div');
	box.style.cssText = 'display: grid; place-items: center; height: 100%; padding: 40px; text-align: center; font-size: 14px; line-height: 1.6; color: var(--ml-color-text); user-select: text; -webkit-user-select: text;';
	const text = document.createElement('p');
	text.style.maxWidth = '460px';
	text.textContent = message;
	box.appendChild(text);
	document.querySelector(target)?.replaceChildren(box);
}

function isEditable(node: EventTarget): boolean {
	return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable);
}

/** Text the user can select keeps the web view's own menu (Copy, Look Up); the rest of the window is not a web page. */
function wantsNativeMenu(e: MouseEvent): boolean {
	const path = e.composedPath();
	if (path.some(isEditable)) {
		return true;
	}
	const target = path.find((node): node is Element => node instanceof Element);
	if (!target) {
		return false;
	}
	const style = getComputedStyle(target);
	// Safari only knows the prefixed property.
	return (style.userSelect || style.webkitUserSelect || 'none') !== 'none';
}

/**
 * Resolves when the app can start in this web view. In one that is too old it puts the
 * reason on screen instead and never resolves, so whatever follows the `await` does not run.
 */
export function platformReady(target: string): Promise<void> {
	const problem = webviewProblem();
	if (!problem) {
		installDesktopGuards();
		return Promise.resolve();
	}
	showProblem(target, problem);
	return new Promise(() => undefined);
}

/**
 * In the packaged app, stop the web view from acting like a browser tab: its own
 * right-click menu (Reload, Back, Save as, Print on WebView2) and the reload keys
 * (F5 and Ctrl+R on WebView2) would throw away unsaved edits. Development builds
 * keep both, for Reload and Inspect.
 */
function installDesktopGuards(): void {
	if (!isDesktop() || import.meta.env.DEV) {
		return;
	}
	// Bubble phase on purpose: components with their own menu or shortcut have had their turn.
	window.addEventListener('contextmenu', (e) => {
		if (!e.defaultPrevented && !wantsNativeMenu(e)) {
			e.preventDefault();
		}
	});
	window.addEventListener('keydown', (e) => {
		const key = e.key.toLowerCase();
		if (key === 'f5' || ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'r')) {
			e.preventDefault();
		}
	});
}
