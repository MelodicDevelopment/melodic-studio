#!/usr/bin/env node
/**
 * Runs the app's own language-server client (src/services/lsp/protocol.ts, the
 * part that needs no Monaco) against a real server over stdio: initialize,
 * open files, then hover, definition, document symbols and diagnostics.
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
 *   definition?: { needle, file, text },  // lands in `file`, on a line holding `text`
 *   symbols?: string[],                   // names the outline must hold
 *   diagnostics?: string | null,          // a marker message must contain it; null = no errors
 * }] }
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const { Client, languageId, hoverContents, locations, documentSymbols, markers } = await import(pathToFileURL(join(here, '../src/services/lsp/protocol.ts')).href);
const capabilities = JSON.parse(readFileSync(join(here, '../src/services/lsp/capabilities.json'), 'utf8'));

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

/** Latest published diagnostics by URI, as the editor markers they become. */
const published = new Map();
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
	client.notify('textDocument/didClose', { textDocument: { uri } });
}

await client.request('shutdown', null, 5_000);
client.notify('exit', null);
await sleep(200);
child.kill();
console.log(JSON.stringify({ server: plan.server, ok: true, uris: uriSource, results }, null, 2));
process.exit(0);
