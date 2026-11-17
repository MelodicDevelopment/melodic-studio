/**
 * Appearance: dark by default, with light and follow-the-OS modes. The choice
 * lives in localStorage; Melodic's applyTheme sets `data-theme` on <html>.
 */
import { applyTheme, getResolvedTheme } from '@melodicdev/components/theme';
import { isDesktop } from '../services/backend.service';

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'repoman.theme';

export function savedTheme(): ThemeMode {
	try {
		const v = localStorage.getItem(KEY);
		if (v === 'light' || v === 'dark' || v === 'system') {
			return v;
		}
	} catch {
		/* blocked storage */
	}
	return 'dark';
}

export function setTheme(mode: ThemeMode): void {
	try {
		localStorage.setItem(KEY, mode);
	} catch {
		/* ignore */
	}
	applyTheme(mode);
	void syncWindowChrome(mode);
}

export function initTheme(): void {
	applyTheme(savedTheme());
	void syncWindowChrome(savedTheme());
}

/** Keep the native title bar (traffic lights) in step with the page. */
async function syncWindowChrome(mode: ThemeMode): Promise<void> {
	if (!isDesktop()) {
		return;
	}
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		await getCurrentWindow().setTheme(mode === 'system' ? null : getResolvedTheme());
	} catch {
		/* the page still themes itself */
	}
}
