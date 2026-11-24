/**
 * A fresh app for one test: every module loaded again (so every store and the demo backend start
 * over), storage emptied, and the backend's `call` wrapped so a test can see what was asked of the
 * native side and answer a command itself.
 *
 *   const w = await world();
 *   const { RepoStore } = await import('../services/repo.store');
 *   const repos = w.get(RepoStore);
 *
 * Import the stores after `world()`, with `await import`, never at the top of the file: a module
 * imported at the top belongs to the app before the reset.
 */
import { vi } from 'vitest';

export interface Call {
	cmd: string;
	args: Record<string, unknown>;
}

export interface Toast {
	kind: string;
	title: string;
	message: string;
}

type Answer = (args: Record<string, unknown>) => unknown;

export interface World {
	/** Every command sent to the native side, in order. */
	calls: Call[];
	/** The calls of one command. */
	sent(cmd: string): Call[];
	/** Answer `cmd` here instead of in the demo backend. Throw (or return a rejected promise) for a failure. */
	on(cmd: string, answer: Answer): void;
	/** Back to the demo backend's own answer. */
	off(cmd: string): void;
	/** An event from the native side, to everything listening for it. */
	emit(event: string, payload: unknown): void;
	/** The app's one instance of a service. */
	get<T>(token: new (...args: never[]) => T): T;
	/** Toasts shown so far. */
	toasts: Toast[];
}

/** An error shaped as the native side sends them. */
export function appError(kind: 'conflict' | 'auth' | 'git' | 'error', message: string, paths: string[] = []): { kind: string; message: string; paths: string[] } {
	return { kind, message, paths };
}

/** Lets everything already queued (promises, zero timers) run. Under fake timers it moves their clock by nothing instead of waiting. */
export async function settle(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) {
		if (vi.isFakeTimers()) {
			await vi.advanceTimersByTimeAsync(0);
		} else {
			await new Promise((r) => setTimeout(r, 0));
		}
	}
}

/**
 * Melodic defines an element only while its name is free, and the page keeps its registry when the
 * modules are loaded again. Without this the second test of a file would mount the first test's
 * component class, tied to the first test's stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const value = registry[key];
		if (value instanceof Map) {
			value.clear();
		}
	}
}

export async function world(): Promise<World> {
	(globalThis as { __forgetListeners?: () => void }).__forgetListeners?.();
	forgetElements();
	vi.resetModules();
	localStorage.clear();
	sessionStorage.clear();
	document.body.replaceChildren();

	const { Injector } = await import('@melodicdev/core/injection');
	const { BackendService } = await import('../services/backend.service');
	const { ToastService } = await import('@melodicdev/components/toast');

	const backend = Injector.get(BackendService);
	const calls: Call[] = [];
	const answers = new Map<string, Answer>();
	const listeners = new Map<string, Set<(payload: unknown) => void>>();

	// The demo backend's own answer, without the pause it makes for the preview's sake.
	const demo = (backend as unknown as { _demo: { handle(cmd: string, args: Record<string, unknown>): unknown } })._demo;
	backend.call = (async (cmd: string, args: Record<string, unknown> = {}) => {
		calls.push({ cmd, args });
		await Promise.resolve();
		const answer = answers.get(cmd);
		return answer ? answer(args) : demo.handle(cmd, args);
	}) as typeof backend.call;

	const demoListen = backend.listen.bind(backend);
	backend.listen = (async (event: string, handler: (payload: unknown) => void) => {
		const set = listeners.get(event) ?? new Set();
		set.add(handler);
		listeners.set(event, set);
		const stop = await demoListen(event, handler);
		return () => {
			set.delete(handler);
			stop();
		};
	}) as typeof backend.listen;

	// Toasts are recorded, not drawn: the element they would go in is not what a store test is about.
	const toasts: Toast[] = [];
	const toast = Injector.get(ToastService);
	const ref = { dismiss: () => {}, element: document.createElement('div') };
	toast.show = (config) => {
		toasts.push({ kind: config.variant ?? 'info', title: config.title ?? '', message: config.message ?? '' });
		return ref;
	};
	for (const kind of ['success', 'error', 'info', 'warning'] as const) {
		toast[kind] = (title: string, message = '') => {
			toasts.push({ kind, title, message });
			return ref;
		};
	}

	return {
		calls,
		sent: (cmd) => calls.filter((c) => c.cmd === cmd),
		on: (cmd, answer) => void answers.set(cmd, answer),
		off: (cmd) => void answers.delete(cmd),
		emit: (event, payload) => listeners.get(event)?.forEach((h) => h(payload)),
		get: (token) => Injector.get(token as never) as never,
		toasts,
	};
}
