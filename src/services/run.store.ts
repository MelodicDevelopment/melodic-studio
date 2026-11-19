/**
 * Run: the targets Studio found in the checkout on screen, which one is selected, and the runs
 * it has started. A run is a tab in the bottom terminal panel (the program on a pty), so its
 * output is live and Stop is closing that pty. Because Studio started it, it knows the exact
 * command, the exit code and everything that was printed, which is what lets Investigate
 * reproduce a failure.
 *
 * The output is read as it arrives by `ErrorSpotter`; what it finds shows as the "Error spotted"
 * bar over the run's tab and as the "Crashed here" mark in the Files tab.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { computed, signal } from '@melodicdev/core/signals';
import { BackendService, type RunTarget } from './backend.service';
import { RepoStore } from './repo.store';
import { TerminalStore } from './terminal.store';
import { ErrorSpotter, crashSite, type SpottedError } from '../shared/error-spotting';
import { repoRelative, samePath } from './agent-paths';

export interface RunError extends SpottedError {
	id: string;
	/** When it was spotted (ms). */
	at: number;
	dismissed: boolean;
	/** The frame inside the checkout it crashed at, repository-relative. */
	site: { path: string; line: number; column: number | null } | null;
}

export interface Run {
	/** Also the id of its tab in the terminal panel. */
	id: string;
	repoId: string;
	/** The checkout it runs in (the repository, or the worktree that was on screen). */
	checkout: string;
	target: RunTarget;
	command: string;
	/** The port a worktree's copy was told to use; null in the main checkout. */
	port: number | null;
	started: number;
	state: 'running' | 'ended' | 'stopped';
	exitCode: number | null;
	errors: RunError[];
}

/** A crash to mark in the editor. */
export interface CrashMark {
	path: string;
	line: number;
	type: string | null;
	summary: string;
	at: number;
}

const SELECTED_KEY = 'studio.run.selected';
/** The names a target that starts the app usually has, best first; used until the user has picked one. */
const USUAL_NAMES = ['dev', 'start', 'serve', 'https', 'http', 'runserver'];
/** How long the output has to be quiet before a block still open in it is taken as complete. */
const QUIET_MS = 500;

function loadSelected(): Record<string, string> {
	try {
		const v = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? '{}');
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** The first part of a target's group, which names the project: "Shop.Api · launch profiles" -> "Shop.Api". */
export function projectOf(target: RunTarget): string {
	return target.group.split(' · ')[0];
}

/** A target as the toolbar and its tab name it: "Shop.Api · https", "web · dev". A group that is only a file name adds nothing. */
export function targetTitle(target: RunTarget): string {
	const project = projectOf(target);
	return project === target.source || project === target.name ? target.name : `${project} · ${target.name}`;
}

/** Targets under their group headings, in the order they were found. */
export function groupTargets(targets: RunTarget[]): { group: string; targets: RunTarget[] }[] {
	const out: { group: string; targets: RunTarget[] }[] = [];
	for (const t of targets) {
		const last = out.find((g) => g.group === t.group);
		if (last) {
			last.targets.push(t);
		} else {
			out.push({ group: t.group, targets: [t] });
		}
	}
	return out;
}

/** The files a group's targets were read from, for its heading's tooltip: "Found in launchSettings.json". */
export function foundIn(targets: RunTarget[]): string {
	const files = [...new Set(targets.map((t) => t.source))];
	return files.length ? `Found in ${files.join(', ')}` : '';
}

/** The targets whose group, name or command line has every word of `text`. */
export function filterTargets(targets: RunTarget[], text: string): RunTarget[] {
	const words = text.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) {
		return targets;
	}
	return targets.filter((t) => {
		const hay = `${t.group} ${t.name} ${t.argv.join(' ')}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** A frame's file as a repository-relative path: absolute paths inside the checkout, and paths relative to where the program ran. */
export function frameInCheckout(file: string, checkout: string, cwd: string): string | null {
	const absolute = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);
	if (absolute) {
		return repoRelative(file, checkout);
	}
	const relative = repoRelative(file, null);
	return relative === null ? null : cwd ? `${cwd}/${relative}` : relative;
}

@Injectable()
export class RunStore {
	/** The targets of the checkout on screen; null until they have been looked for. */
	readonly targets = signal<RunTarget[] | null>(null);
	readonly loading = signal(false);
	/** The selected target of each repository, by id. */
	private readonly _selected = signal<Record<string, string>>(loadSelected());
	/** Every run that still has its tab, in every repository. */
	readonly runs = signal<Run[]>([]);

	private _loadedFor = '';
	/** The checkout `targets` belongs to. */
	private _place = '';
	/** What was found in each checkout looked at so far, so going back to one shows its targets at once. */
	private readonly _seen = new Map<string, RunTarget[]>();
	private readonly _spotters = new Map<string, { spotter: ErrorSpotter; quiet: ReturnType<typeof setTimeout> | null }>();
	private _seq = 0;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}
	private get terminals(): TerminalStore {
		return Injector.get(TerminalStore);
	}

	/** The checkout on screen. */
	private checkout(): { repoId: string; path: string } | null {
		const repo = this.repos.repo();
		return repo ? { repoId: repo.id, path: repo.worktree || repo.path } : null;
	}

	/** The selected target: the one remembered for this repository, else the likeliest way to start the app. */
	readonly selected = computed<RunTarget | null>(() => {
		const targets = this.targets() ?? [];
		const wanted = this._selected()[this.repos.repo()?.id ?? ''];
		const apps = targets.filter((t) => t.kind === 'run');
		// `build` and `lint` are scripts too, but nobody means them by "run".
		const usual = USUAL_NAMES.map((name) => apps.find((t) => t.name === name)).find(Boolean);
		return targets.find((t) => t.id === wanted) ?? usual ?? apps[0] ?? targets[0] ?? null;
	});

	/** The runs of the checkout on screen whose tabs are still open, newest first. */
	readonly here = computed<Run[]>(() => {
		const at = this.checkout();
		const open = new Set(this.terminals.all().map((t) => t.id));
		return this.runs()
			.filter((r) => at && r.repoId === at.repoId && samePath(r.checkout, at.path) && open.has(r.id))
			.sort((a, b) => b.started - a.started);
	});

	/** The latest run of the selected target here, if it has one. */
	readonly current = computed<Run | null>(() => {
		const id = this.selected()?.id;
		return this.here().find((r) => r.target.id === id) ?? null;
	});

	/** Where the runs of this checkout crashed, newest first, one per line of code. */
	readonly crashes = computed<CrashMark[]>(() => {
		const marks = new Map<string, CrashMark>();
		for (const run of this.here()) {
			for (const e of run.errors) {
				if (!e.site || e.dismissed) {
					continue;
				}
				const key = `${e.site.path}:${e.site.line}`;
				const had = marks.get(key);
				if (!had || had.at < e.at) {
					marks.set(key, { path: e.site.path, line: e.site.line, type: e.type, summary: e.summary, at: e.at });
				}
			}
		}
		return [...marks.values()].sort((a, b) => b.at - a.at);
	});

	/** The run behind a tab of the terminal panel. */
	run(id: string | null): Run | null {
		return (id && this.runs().find((r) => r.id === id)) || null;
	}

	/**
	 * Look for the targets of the checkout on screen, when the checkout or its branch has changed
	 * since the last look (or `force`). In another checkout the targets are the ones seen there
	 * before, or null, until the look is done: the toolbar shows no Run control for null or none.
	 */
	async load(force = false): Promise<void> {
		const at = this.checkout();
		const place = at ? `${at.repoId}\n${at.path}` : '';
		const key = at ? `${place}\n${this.repos.status()?.branch ?? ''}` : '';
		if (!force && key === this._loadedFor) {
			return;
		}
		this._loadedFor = key;
		if (place !== this._place) {
			this._place = place;
			this.targets.set(this._seen.get(place) ?? null);
		}
		if (!at) {
			return;
		}
		this.loading.set(true);
		try {
			const targets = await this.backend.targets(at.repoId);
			this._seen.set(place, targets);
			if (this._loadedFor === key) {
				this.targets.set(targets);
			}
		} catch {
			if (this._loadedFor === key) {
				this.targets.set([]);
			}
		} finally {
			this.loading.set(false);
		}
	}

	select(target: RunTarget): void {
		const repo = this.repos.repo()?.id;
		if (!repo) {
			return;
		}
		const next = { ...this._selected(), [repo]: target.id };
		this._selected.set(next);
		try {
			localStorage.setItem(SELECTED_KEY, JSON.stringify(next));
		} catch {
			/* only a convenience */
		}
	}

	private update(id: string, change: (r: Run) => Run): void {
		this.runs.set(this.runs().map((r) => (r.id === id ? change(r) : r)));
	}

	private spotted(id: string, found: SpottedError[]): void {
		const run = this.run(id);
		if (!run || !found.length) {
			return;
		}
		const errors = found.map<RunError>((e) => ({
			...e,
			id: `e${++this._seq}`,
			at: Date.now(),
			dismissed: false,
			site: crashSite(e, (file) => frameInCheckout(file, run.checkout, run.target.cwd)),
		}));
		this.update(id, (r) => ({ ...r, errors: [...r.errors, ...errors] }));
	}

	/** Start `target` (the selected one when left out) in the checkout on screen. A copy of it already running here is stopped first. */
	async start(target: RunTarget | null = this.selected()): Promise<Run | null> {
		const at = this.checkout();
		if (!at || !target) {
			return null;
		}
		for (const old of this.here().filter((r) => r.target.id === target.id)) {
			// Its tab goes too: the new run takes its place.
			this.terminals.close(old.id);
		}
		this.forget();
		const spotter = new ErrorSpotter();
		let id = '';
		// The tab exists before the program has started, so output can arrive before `id` is known here.
		const early: string[] = [];
		const read = (text: string): void => {
			if (!id) {
				early.push(text);
				return;
			}
			const entry = this._spotters.get(id);
			if (!entry) {
				return;
			}
			this.spotted(id, entry.spotter.push(text));
			if (entry.quiet) {
				clearTimeout(entry.quiet);
			}
			entry.quiet = setTimeout(() => this.spotted(id, entry.spotter.flush()), QUIET_MS);
		};
		let info: { port: number | null; command: string } = { port: null, command: target.argv.join(' ') };
		// A program can also end before its tab is known here (a command that fails at once).
		let exited: { code: number | null } | null = null;
		try {
			id = await this.terminals.addProgram({
				repoId: at.repoId,
				title: targetTitle(target),
				cwd: at.path,
				kind: 'run',
				reveal: true,
				output: read,
				exit: (code) => (id ? this.ended(id, code) : void (exited = { code })),
				open: async (cols, rows) => {
					const started = await this.backend.targetRun(at.repoId, target.id, cols, rows);
					info = { port: started.port, command: started.command };
					return { key: started.key, command: started.command };
				},
			});
		} catch (e) {
			this.repos.fail(e);
			return null;
		}
		const run: Run = { id, repoId: at.repoId, checkout: at.path, target, command: info.command, port: info.port, started: Date.now(), state: 'running', exitCode: null, errors: [] };
		this._spotters.set(id, { spotter, quiet: null });
		this.runs.set([...this.runs(), run]);
		early.splice(0).forEach(read);
		const gone = exited as { code: number | null } | null;
		if (gone) {
			this.ended(id, gone.code);
		}
		return this.run(id);
	}

	private ended(id: string, code: number | null): void {
		const run = this.run(id);
		const entry = this._spotters.get(id);
		if (!run || run.state === 'ended') {
			return;
		}
		if (entry?.quiet) {
			clearTimeout(entry.quiet);
		}
		// Stopped by hand: whatever code the kill left behind is not the program's verdict.
		const stopped = run.state === 'stopped';
		if (entry) {
			this.spotted(id, stopped ? entry.spotter.flush() : entry.spotter.end(code));
			this._spotters.delete(id);
		}
		this.update(id, (r) => ({ ...r, state: stopped ? 'stopped' : 'ended', exitCode: stopped ? null : code }));
	}

	/** Stop a run; its tab and what it printed stay. */
	stop(run: Run | null = this.current()): void {
		if (run?.state !== 'running') {
			return;
		}
		this.update(run.id, (r) => ({ ...r, state: 'stopped' }));
		this.terminals.stop(run.id);
	}

	/** Stop the selected target's run if it has one, and start it again. */
	restart(): Promise<Run | null> {
		return this.start();
	}

	dismiss(runId: string, errorId: string): void {
		this.update(runId, (r) => ({ ...r, errors: r.errors.map((e) => (e.id === errorId ? { ...e, dismissed: true } : e)) }));
	}

	/** Drop the runs whose tabs were closed. */
	private forget(): void {
		const open = new Set(this.terminals.all().map((t) => t.id));
		const kept = this.runs().filter((r) => open.has(r.id));
		if (kept.length !== this.runs().length) {
			this.runs.set(kept);
		}
	}
}

/** For templates outside a component that injects the store. */
export function runs(): RunStore {
	return Injector.get(RunStore);
}
