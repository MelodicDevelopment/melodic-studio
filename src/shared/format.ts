import type { FileStatus } from '../services/backend.service';

// These live with the other path helpers; they understand `C:\…` as well as `/…`.
export { fileName, dirName } from './paths';

export function relativeTime(iso: string | number | null | undefined): string {
	if (!iso) {
		return '';
	}
	const then = typeof iso === 'number' ? iso : Date.parse(iso);
	if (Number.isNaN(then)) {
		return '';
	}
	const s = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (s < 45) {
		return 'just now';
	}
	const m = Math.round(s / 60);
	if (m < 60) {
		return `${m} minute${m === 1 ? '' : 's'} ago`;
	}
	const h = Math.round(m / 60);
	if (h < 24) {
		return `${h} hour${h === 1 ? '' : 's'} ago`;
	}
	const d = Math.round(h / 24);
	if (d < 30) {
		return `${d} day${d === 1 ? '' : 's'} ago`;
	}
	return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function longTime(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then) ? '' : new Date(then).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The one-letter mark and tone shown beside a changed file. */
export function statusMark(status: FileStatus): { letter: string; tone: string; label: string } {
	switch (status) {
		case 'added':
		case 'untracked':
			return { letter: '+', tone: 'add', label: 'New' };
		case 'deleted':
			return { letter: '−', tone: 'del', label: 'Deleted' };
		case 'renamed':
			return { letter: '→', tone: 'ren', label: 'Renamed' };
		case 'conflicted':
			return { letter: '!', tone: 'con', label: 'Conflicted' };
		default:
			return { letter: '•', tone: 'mod', label: 'Modified' };
	}
}

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}
