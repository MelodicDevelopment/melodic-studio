/**
 * Dev builds only (imported from main.ts behind `import.meta.env.DEV`).
 * Puts the app's services on `window.__studio` so a script run through
 * STUDIO_DEV_EVAL (see src-tauri/src/dev.rs) can drive the real window.
 */
import { Injector } from '@melodicdev/core/injection';
import { BackendService } from '../services/backend.service';
import { RepoStore } from '../services/repo.store';
import { AgentsStore } from '../services/agents.store';
import { ExplorerStore } from '../services/explorer.store';
import { AiService } from '../services/ai.service';
import { LspService } from '../services/lsp.service';
import { TerminalStore } from '../services/terminal.store';

const backend = (): BackendService => Injector.get(BackendService);

/** Find elements through shadow roots: `q('ms-app ms-toolbar .seg')` pierces each custom element on the way. */
function q(path: string): Element | null {
	let found: Element | null = null;
	for (const part of path.split(' ')) {
		// Look in the element's shadow root first, then among its own (slotted) children.
		const next: Element | null = found ? (found.shadowRoot?.querySelector(part) ?? found.querySelector(part)) : document.querySelector(part);
		if (!next) {
			return null;
		}
		found = next;
	}
	return found;
}

(window as unknown as { __studio: unknown }).__studio = {
	get backend() {
		return backend();
	},
	get repos() {
		return Injector.get(RepoStore);
	},
	get agents() {
		return Injector.get(AgentsStore);
	},
	get explorer() {
		return Injector.get(ExplorerStore);
	},
	get ai() {
		return Injector.get(AiService);
	},
	get lsp() {
		return Injector.get(LspService);
	},
	get terminal() {
		return Injector.get(TerminalStore);
	},
	/** Any other service, by class: `s.inject(SomeStore)` from a module the script imported. */
	inject: <T>(token: new (...args: never[]) => T): T => Injector.get(token as never),
	q,
	sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
	log: (...parts: unknown[]) => backend().call('dev_log', { line: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') }),
};
