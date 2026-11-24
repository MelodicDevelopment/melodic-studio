#!/usr/bin/env node
/**
 * Runs the app's own language-server client (src/services/lsp/protocol.ts, the
 * part that needs no Monaco) against a real server over stdio: initialize,
 * open files, then completion, signature help, hover, definition, highlights,
 * document symbols, diagnostics, and an edit sent the way the server asked for.
 *
 *   node scripts/lsp-smoke.mjs <plan.json>
 *
 * The plan says which server to start and what to expect. The ignored Rust tests
 * `lsp::e2e::app_client_*` (cargo test -- --ignored e2e) write one per server from
 * the same launch code `lsp_start` uses, then run this script. Needs Node 22.18+
 * (it imports the TypeScript source directly). Servers index in the background, so
 * each question is asked until the answer is right, for LSP_SMOKE_SECONDS (90) at most.
 *
 * Plan: { server, binary, args, env, root, initializationOptions, checks: [{
 *   file, language,                       // path under root, Monaco language id
 *   hover?: { needle, contains },         // hover on the first `needle` in the file
 *   completion?: { after, contains: string[], resolve?: { label, contains } },
 *                                         // suggestions right after the first `after`; one resolved, its detail + documentation checked
 *   signature?: { after, contains },      // signature help right after `after`: a signature's label
 *   highlights?: { needle, count },       // places the name at `needle` is used in this file
 *   definition?: { needle, file, text },  // lands in `file`, on a line holding `text`
 *   symbols?: string[],                   // names the outline must hold
 *   diagnostics?: string | null,          // a marker message must contain it; null = no errors
 *   rename?: { needle, to, files: string[] },  // renaming the name at `needle`: the files the edit covers, and every edit applies
 *   offers?: { [capability]: boolean },   // what the server says it can do, e.g. { renameProvider: false }
 *   symbol?: { query, contains },         // workspace symbol search: a name it must find
 *   hints?: { contains },                 // inlay hints for the whole file: a label one of them carries
 *   tokens?: [{ needle, type }],          // colours by meaning: the name at `needle` is of this kind in the editor's legend ("parameter", "variable.readonly")
 *   lens?: { contains, does },            // a code lens, resolved, whose words contain `contains`; `does` is what a click does (show | references | run | none)
 *   edit?: { after, insert, diagnostics, fix?: { title, text } }, // type `insert` after `after` (as a range if the server takes ranges): an error must follow
 *   disk?: { file, text, clears },        // last: write a new file and tell the server (it has to have asked to be told);
 *                                         // the errors containing `clears` must go, which shows it read the file
 *   (edit.fix: a quick fix offered for that error, by part of its title; applied, the file must hold `text`)
 * }] }
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const { Client, languageId, hoverContents, locations, documentSymbols, markers, completions, resolved, signatureHelp, highlights, syncKind, contentChanges, clientCapabilities, WATCHED_FILES, workspaceEdit, applyTextEdits, codeActions, inlayHints, workspaceSymbols, touches, tokenMap, semanticTokens, TOKEN_TYPES, TOKEN_MODIFIERS, codeLenses, lensCommand } = await import(pathToFileURL(join(here, '../src/services/lsp/protocol.ts')).href);
const shared = JSON.parse(readFileSync(join(here, '../src/services/lsp/capabilities.json'), 'utf8'));

/** The URIs Monaco would make (it escapes more than Node does), when its URI class loads outside a browser. */
let fileUri = (path) => pathToFileURL(path).href;
let uriSource = 'node';
try {
	const { URI } = await import('monaco-editor/base/common/uri.js');
	fileUri = (path) => URI.file(path).toString();
	uriSource = 'monaco';
} catch {
	// Node's own file URLs are close enough to be worth running with.
}

const plan = JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8'));
const capabilities = clientCapabilities(shared, plan.server);
const log = (...parts) => console.error(`[${plan.server}]`, ...parts);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- transport: what src-tauri/src/lsp.rs does in the app ----------------------

const child = spawn(plan.binary, plan.args, {
	cwd: plan.root,
	env: { ...process.env, ...plan.env },
	stdio: ['pipe', 'pipe', 'inherit'],
	// npm's shims are .cmd files on Windows, which only a shell can start.
	shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(plan.binary),
});
let exited = false;
child.on('exit', () => (exited = true));
child.on('error', (e) => fail(`could not start ${plan.binary}: ${e.message}`));

const send = (message) =>
	new Promise((resolve, reject) => {
		const body = Buffer.from(JSON.stringify(message), 'utf8');
		child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]), (e) => (e ? reject(e) : resolve()));
	});

const rootUri = fileUri(plan.root);
const client = new Client({ key: plan.server, root: plan.root, fresh: true, server: plan.server, initializationOptions: plan.initializationOptions ?? null }, rootUri, send);

/** Latest published diagnostics by URI, as the editor markers they become, and as they came. */
const published = new Map();
const reported = new Map();
/** Edits the server asked to have applied (`workspace/applyEdit`), which the app would apply. */
const asked = [];
client.handler = (method, params) => (method === 'workspace/applyEdit' ? (asked.push(params.edit), Promise.resolve({ applied: true })) : undefined);
let buffer = Buffer.alloc(0);
child.stdout.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const head = buffer.indexOf('\r\n\r\n');
		if (head < 0) {
			return;
		}
		const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, head).toString('ascii'))?.[1]);
		if (!Number.isFinite(length) || buffer.length < head + 4 + length) {
			return;
		}
		const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString('utf8'));
		buffer = buffer.subarray(head + 4 + length);
		const note = client.receive(message);
		if (note?.method === 'textDocument/publishDiagnostics') {
			published.set(decodeURIComponent(note.params.uri).toLowerCase(), markers(note.params.diagnostics));
			reported.set(decodeURIComponent(note.params.uri).toLowerCase(), note.params.diagnostics);
		}
	}
});

// ---- checks ----------------------------------------------------------------

const results = [];
function fail(reason) {
	console.log(JSON.stringify({ server: plan.server, ok: false, reason, results }, null, 2));
	child.kill();
	process.exit(1);
}

/** Servers index in the background, so an early question can come back empty. Ask until it does not. */
async function eventually(what, ask, good, seconds = Number(process.env.LSP_SMOKE_SECONDS ?? 90)) {
	const deadline = Date.now() + seconds * 1000;
	let last;
	for (;;) {
		last = await ask();
		if (good(last)) {
			return last;
		}
		if (exited) {
			fail(`${what}: the server exited`);
		}
		if (Date.now() > deadline) {
			fail(`${what}: gave up after ${seconds}s; last answer ${JSON.stringify(last)}`);
		}
		await sleep(500);
	}
}

function position(text, needle) {
	const at = text.indexOf(needle);
	if (at < 0) {
		fail(`"${needle}" is not in the fixture`);
	}
	const before = text.slice(0, at).split('\n');
	return { line: before.length - 1, character: before[before.length - 1].length };
}

/** The place right after the first `needle`. */
function after(text, needle) {
	const at = position(text, needle);
	return { line: at.line, character: at.character + needle.length };
}

log(`starting ${plan.binary} in ${plan.root} (${uriSource} URIs)`);
if (!(await client.initialize(capabilities))) {
	fail(`initialize failed: ${client.error ?? (exited ? 'the server exited' : 'no answer')}`);
}
log('initialized; server capabilities:', Object.keys(client.capabilities).join(', '));

for (const check of plan.checks) {
	const path = join(plan.root, check.file);
	const uri = fileUri(path);
	const text = readFileSync(path, 'utf8');
	const id = languageId(check.language, check.file);
	client.notify('textDocument/didOpen', { textDocument: { uri, languageId: id, version: 1, text } });
	const result = { file: check.file, languageId: id };
	results.push(result);

	if (check.hover) {
		const params = { textDocument: { uri }, position: position(text, check.hover.needle) };
		const hover = await eventually(
			`hover on ${check.hover.needle} in ${check.file}`,
			async () => hoverContents((await client.request('textDocument/hover', params))?.contents).join('\n'),
			(value) => value.includes(check.hover.contains)
		);
		result.hover = hover;
	}
	if (check.completion) {
		const at = after(text, check.completion.after);
		const params = { textDocument: { uri }, position: at, context: { triggerKind: 1 } };
		const here = { startLineNumber: at.line + 1, startColumn: at.character + 1, endLineNumber: at.line + 1, endColumn: at.character + 1 };
		const label = (s) => (typeof s.label === 'string' ? s.label : s.label.label);
		const list = await eventually(
			`completion after ${check.completion.after} in ${check.file}`,
			async () => completions(await client.request('textDocument/completion', params), { insert: here, replace: here }).suggestions,
			(found) => check.completion.contains.every((wanted) => found.some((s) => label(s) === wanted))
		);
		result.completion = { count: list.length, has: check.completion.contains };
		if (check.completion.resolve) {
			const shown = list.find((s) => label(s) === check.completion.resolve.label);
			const full = resolved(shown, await client.request('completionItem/resolve', shown.item));
			const said = `${full.detail ?? ''}\n${typeof full.documentation === 'string' ? full.documentation : (full.documentation?.value ?? '')}`;
			if (!said.includes(check.completion.resolve.contains)) {
				fail(`resolving ${check.completion.resolve.label} said "${said}", expected "${check.completion.resolve.contains}"`);
			}
			result.completion.resolved = said.trim();
		}
	}
	if (check.signature) {
		const params = { textDocument: { uri }, position: after(text, check.signature.after), context: { triggerKind: 1, isRetrigger: false } };
		const help = await eventually(
			`signature help after ${check.signature.after} in ${check.file}`,
			async () => signatureHelp(await client.request('textDocument/signatureHelp', params)),
			(value) => !!value?.signatures.some((s) => s.label.includes(check.signature.contains))
		);
		result.signature = help.signatures.map((s) => s.label);
	}
	if (check.highlights) {
		const params = { textDocument: { uri }, position: position(text, check.highlights.needle) };
		result.highlights = await eventually(
			`highlights of ${check.highlights.needle} in ${check.file}`,
			async () => highlights(await client.request('textDocument/documentHighlight', params)).map((h) => `${h.range.startLineNumber}:${h.range.startColumn}`),
			(list) => list.length === check.highlights.count
		);
	}
	for (const [capability, wanted] of Object.entries(check.offers ?? {})) {
		if (!!client.capabilities[capability] !== wanted) {
			fail(`${plan.server} ${wanted ? 'should offer' : 'should not offer'} ${capability}, and says ${JSON.stringify(client.capabilities[capability])}`);
		}
	}
	if (check.rename) {
		const params = { textDocument: { uri }, position: position(text, check.rename.needle), newName: check.rename.to };
		const same = (a, b) => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();
		const files = await eventually(
			`renaming ${check.rename.needle} in ${check.file}`,
			async () => (workspaceEdit(await client.request('textDocument/rename', params)) ?? []).filter((step) => step.kind === 'edit'),
			(list) => check.rename.files.every((file) => list.some((f) => same(f.uri, fileUri(join(plan.root, file)))))
		);
		result.rename = {};
		for (const file of check.rename.files) {
			const found = files.find((f) => same(f.uri, fileUri(join(plan.root, file))));
			const after = applyTextEdits(readFileSync(join(plan.root, file), 'utf8'), found.edits);
			if (after === null || !after.includes(check.rename.to)) {
				fail(`the rename's edits to ${file} do not apply: ${JSON.stringify(found.edits)}`);
			}
			result.rename[file] = found.edits.length;
		}
	}
	if (check.symbol) {
		result.symbol = await eventually(
			`searching the workspace for ${check.symbol.query}`,
			async () => workspaceSymbols(await client.request('workspace/symbol', { query: check.symbol.query })).map((s) => s.name),
			(names) => names.some((name) => name.includes(check.symbol.contains))
		);
	}
	if (check.hints) {
		const whole = { start: { line: 0, character: 0 }, end: { line: text.split('\n').length, character: 0 } };
		result.hints = await eventually(
			`inlay hints in ${check.file}`,
			async () => inlayHints(await client.request('textDocument/inlayHint', { textDocument: { uri }, range: whole })).map((h) => h.label),
			(labels) => labels.some((label) => label.includes(check.hints.contains))
		);
	}
	if (check.tokens) {
		const map = tokenMap(client.capabilities);
		if (!map) {
			fail(`${plan.server} does not colour files by meaning`);
		}
		/** "line:column" of each coloured name -> its kind, as the editor would look its colour up. */
		const kinds = async () => {
			const data = semanticTokens(await client.request('textDocument/semanticTokens/full', { textDocument: { uri } }), map) ?? [];
			const found = new Map();
			let line = 0;
			let column = 0;
			for (let i = 0; i < data.length; i += 5) {
				line += data[i];
				column = data[i] === 0 ? column + data[i + 1] : data[i + 1];
				found.set(`${line}:${column}`, [TOKEN_TYPES[data[i + 3]], ...TOKEN_MODIFIERS.filter((_, bit) => data[i + 4] & (1 << bit))].join('.'));
			}
			return found;
		};
		const wanted = check.tokens.map((t) => ({ ...t, at: position(text, t.needle) }));
		const found = await eventually(`colours by meaning in ${check.file}`, kinds, (map) => wanted.every((t) => map.get(`${t.at.line}:${t.at.character}`) === t.type));
		result.tokens = { count: found.size, checked: wanted.map((t) => `${t.needle} is ${t.type}`) };
	}
	if (check.lens) {
		const resolvedLenses = async () => {
			const out = [];
			for (const { raw } of codeLenses(await client.request('textDocument/codeLens', { textDocument: { uri } }))) {
				const lens = raw.command ? raw : ((await client.request('codeLens/resolve', raw)) ?? raw);
				const command = lensCommand(lens.command, client.capabilities);
				if (command) {
					out.push({ title: command.title, does: command.does.kind, line: raw.range.start.line });
				}
			}
			return out;
		};
		const lenses = await eventually(`code lens in ${check.file}`, resolvedLenses, (list) => list.some((l) => l.title.includes(check.lens.contains) && l.does === check.lens.does));
		result.lenses = lenses;
	}
	if (check.definition) {
		const params = { textDocument: { uri }, position: position(text, check.definition.needle) };
		const wanted = fileUri(join(plan.root, check.definition.file));
		const same = (a, b) => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();
		const found = await eventually(
			`definition of ${check.definition.needle} in ${check.file}`,
			async () => locations(await client.request('textDocument/definition', params)),
			(list) => list.some((l) => same(l.uri, wanted))
		);
		const target = found.find((l) => same(l.uri, wanted));
		const line = readFileSync(join(plan.root, check.definition.file), 'utf8').split('\n')[target.range.startLineNumber - 1] ?? '';
		if (!line.includes(check.definition.text)) {
			fail(`definition of ${check.definition.needle} landed on "${line.trim()}", expected a line with "${check.definition.text}"`);
		}
		result.definition = { uri: target.uri, line: target.range.startLineNumber, text: line.trim() };
	}
	if (check.symbols) {
		const names = (list) => list.flatMap((s) => [s.name, ...names(s.children)]);
		result.symbols = await eventually(
			`outline of ${check.file}`,
			async () => names(documentSymbols(await client.request('textDocument/documentSymbol', { textDocument: { uri } }))),
			(list) => check.symbols.every((name) => list.some((n) => n.includes(name)))
		);
	}
	if (check.diagnostics !== undefined) {
		const errors = () => (published.get(decodeURIComponent(uri).toLowerCase()) ?? []).filter((m) => m.severity === 8);
		if (check.diagnostics === null) {
			// Nothing to wait for, so wait for the answers above to have had their analysis, then look.
			await sleep(1500);
			if (errors().length) {
				fail(`${check.file} should be clean, got ${JSON.stringify(errors())}`);
			}
			result.diagnostics = [];
		} else {
			result.diagnostics = await eventually(
				`diagnostics for ${check.file}`,
				async () => errors().map((m) => m.message),
				(list) => list.some((m) => m.includes(check.diagnostics))
			);
		}
	}
	if (check.edit) {
		const at = after(text, check.edit.after);
		const kind = syncKind(client.capabilities);
		const range = { startLineNumber: at.line + 1, startColumn: at.character + 1, endLineNumber: at.line + 1, endColumn: at.character + 1 };
		const offset = text.indexOf(check.edit.after) + check.edit.after.length;
		const whole = text.slice(0, offset) + check.edit.insert + text.slice(offset);
		if (check.disk) {
			check.disk.now = whole;
		}
		client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: contentChanges(kind, [{ range, text: check.edit.insert }], () => whole) });
		const errors = () => (published.get(decodeURIComponent(uri).toLowerCase()) ?? []).filter((m) => m.severity === 8).map((m) => m.message);
		result.edit = { sent: kind === 2 ? 'range' : 'whole text', diagnostics: await eventually(`diagnostics after an edit to ${check.file}`, async () => errors(), (list) => list.some((m) => m.includes(check.edit.diagnostics))) };
		if (check.edit.fix) {
			// As the app asks: for the server's own diagnostic, at its place.
			const diagnostic = (reported.get(decodeURIComponent(uri).toLowerCase()) ?? []).find((d) => d.message.includes(check.edit.diagnostics));
			const offered = await eventually(
				`a quick fix for "${check.edit.diagnostics}" in ${check.file}`,
				async () => codeActions(await client.request('textDocument/codeAction', { textDocument: { uri }, range: diagnostic.range, context: { diagnostics: [diagnostic].filter((d) => touches(d.range, diagnostic.range)), triggerKind: 1 } })),
				(list) => list.some((a) => a.title.includes(check.edit.fix.title))
			);
			let action = offered.find((a) => a.title.includes(check.edit.fix.title)).raw;
			if (!action.edit && !action.command && client.capabilities.codeActionProvider?.resolveProvider) {
				action = (await client.request('codeAction/resolve', action)) ?? action;
			}
			let fix = action.edit;
			if (!fix && action.command?.command) {
				// The server works the edit out itself and asks for it to be applied.
				await client.request('workspace/executeCommand', { command: action.command.command, arguments: action.command.arguments });
				fix = await eventually('the edit of that fix', async () => asked.pop(), (e) => !!e, 15);
			}
			const mine = (workspaceEdit(fix) ?? []).find((f) => decodeURIComponent(f.uri).toLowerCase() === decodeURIComponent(uri).toLowerCase());
			const fixed = mine ? applyTextEdits(whole, mine.edits) : null;
			if (!fixed || !fixed.includes(check.edit.fix.text)) {
				fail(`the fix "${check.edit.fix.title}" did not leave "${check.edit.fix.text}" in ${check.file}: ${JSON.stringify(fix)}`);
			}
			result.edit.fix = { offered: offered.map((a) => a.title), applied: check.edit.fix.title };
		}
	}
	if (check.disk) {
		await eventually(`${plan.server} asking to be told of files changing on disk`, async () => client.registered.has(WATCHED_FILES), (asked) => asked, 30);
		writeFileSync(join(plan.root, check.disk.file), check.disk.text);
		client.notify(WATCHED_FILES, { changes: [{ uri: fileUri(join(plan.root, check.disk.file)), type: 1 }] });
		const left = () => (published.get(decodeURIComponent(uri).toLowerCase()) ?? []).filter((m) => m.severity === 8 && m.message.includes(check.disk.clears)).map((m) => m.message);
		// Some servers take the file in but only look at an open document again when it is edited:
		// after a while, send that document once more as it is, which is what the app does too.
		const began = Date.now();
		let nudged = false;
		await eventually(
			`errors with "${check.disk.clears}" in ${check.file} going once ${check.disk.file} is on disk`,
			async () => {
				if (!nudged && left().length && Date.now() - began > 5000) {
					nudged = true;
					client.notify('textDocument/didChange', { textDocument: { uri, version: 99 }, contentChanges: [{ text: check.disk.now ?? text }] });
				}
				return left();
			},
			(list) => list.length === 0
		);
		result.disk = { wrote: check.disk.file, cleared: check.disk.clears, nudged };
	}
	client.notify('textDocument/didClose', { textDocument: { uri } });
}

await client.request('shutdown', null, 5_000);
client.notify('exit', null);
await sleep(200);
child.kill();
console.log(JSON.stringify({ server: plan.server, ok: true, uris: uriSource, results }, null, 2));
process.exit(0);
