/**
 * Error spotting against output captured from the real tools (shared/testdata/errors; the Go
 * trace is written out by hand in Go's format). Paths in the captures were shortened to
 * /Users/rick/src/...; nothing else was touched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ErrorSpotter, crashSite, spotErrors, stripAnsi, type SpottedError } from './error-spotting.ts';

const captured = (name: string): string => readFileSync(new URL(`./testdata/errors/${name}.txt`, import.meta.url), 'utf8');
const where = (e: SpottedError): string[] => e.frames.map((f) => `${f.file.split('/').pop()}:${f.line}${f.fn ? ` ${f.fn}` : ''}`);

test('ASP.NET: an unhandled exception in a request', () => {
	const errors = spotErrors(captured('dotnet-api'));
	assert.equal(errors.length, 1);
	const [e] = errors;
	assert.equal(e.summary, 'POST /api/orders returned 500 · NullReferenceException in ApplyDiscount');
	assert.deepEqual([e.kind, e.runtime, e.type, e.message], ['exception', 'dotnet', 'NullReferenceException', 'Object reference not set to an instance of an object.']);
	// Only the frames with a file: framework frames have none.
	assert.deepEqual(where(e), ['PricingService.cs:20 Shop.Pricing.PricingService.ApplyDiscount', 'CheckoutService.cs:20 Shop.Checkout.CheckoutService.PlaceOrder', 'OrdersController.cs:20 Shop.Api.Controllers.OrdersController.Create']);
	assert.match(e.text, /^fail: Microsoft\.AspNetCore\.Diagnostics\.DeveloperExceptionPageMiddleware\[1\]/);
	assert.ok(!e.text.includes('Request finished'), 'the block ends where the log entry does');
	assert.equal(captured('dotnet-api').split('\n')[e.line], e.text.split('\n')[0]);
});

test('.NET: an unhandled exception in a console program', () => {
	const [e, ...rest] = spotErrors(captured('dotnet-console'), 134);
	assert.equal(rest.length, 0, 'the exit code is explained by the exception');
	assert.equal(e.summary, 'InvalidOperationException in Run', 'the function named is the first of the program\'s own, not the framework frame above it');
	assert.deepEqual(where(e), ['TierSeeder.cs:31 Seed.TierSeeder.Run', 'Program.cs:4 Program.<Main>$']);
});

test('dotnet test: a failed test', () => {
	const errors = spotErrors(captured('dotnet-test'), 1);
	assert.equal(errors.length, 1);
	const [e] = errors;
	assert.equal(e.summary, 'Archived_tier_prices_as_standard failed · NullReferenceException in ApplyDiscount');
	assert.deepEqual([e.kind, e.runtime, e.test], ['test', 'dotnet', 'Shop.Tests.ArchivedTests.Archived_tier_prices_as_standard']);
	assert.deepEqual(where(e).slice(0, 2), ['PricingService.cs:20 Shop.Pricing.PricingService.ApplyDiscount', 'TempFail.cs:11 Shop.Tests.ArchivedTests.Archived_tier_prices_as_standard']);
});

test('Node: an uncaught error, a logged one and a rejected promise', () => {
	const [crash, ...none] = spotErrors(captured('node'), 1);
	assert.equal(none.length, 0);
	assert.equal(crash.summary, 'TypeError in applyDiscount');
	assert.equal(crash.message, "Cannot read properties of null (reading 'multiplier')");
	assert.deepEqual(where(crash), ['crash.js:3 applyDiscount', 'crash.js:6 placeOrder', 'crash.js:8 Object.<anonymous>'], 'node: internals are not files');
	assert.equal(crash.frames[0].column, 29);

	const two = spotErrors(captured('node2'), 1);
	assert.deepEqual(two.map((e) => e.summary), ['Error in handler', 'RangeError: out of range']);
});

test('Python: chained tracebacks are one error', () => {
	const errors = spotErrors(captured('python'), 1);
	assert.equal(errors.length, 1);
	const [e] = errors;
	assert.deepEqual([e.runtime, e.type, e.message, e.summary], ['python', 'RuntimeError', 'checkout failed', 'RuntimeError in main']);
	// Where it first went wrong comes first, then the traceback it was re-raised from.
	assert.deepEqual(where(e), ['crash.py:6 apply_discount', 'crash.py:10 main', 'crash.py:12 main', 'crash.py:14']);
	assert.match(e.text, /TypeError: 'NoneType' object is not subscriptable/);
});

test('Rust: a panic, and a failed cargo test', () => {
	const [panic, ...none] = spotErrors(captured('rust'), 101);
	assert.equal(none.length, 0);
	assert.equal(panic.summary, 'Panic at src/main.rs:6 · called `Option::unwrap()` on a `None` value');
	assert.deepEqual(panic.frames, [{ file: 'src/main.rs', line: 6, column: 40, fn: null }]);
	// The format before Rust 1.73 had the message on the same line.
	const old = spotErrors("thread 'main' panicked at 'index out of bounds', src/lib.rs:9:5\nnote: run with `RUST_BACKTRACE=1`\n");
	assert.deepEqual([old[0].message, old[0].frames[0].line], ['index out of bounds', 9]);

	const tests = spotErrors(captured('cargotest'), 101);
	assert.equal(tests.length, 1, 'the panic inside the test, "test result: FAILED" and the exit code are all the same failure');
	assert.equal(tests[0].summary, 'archived_tier_prices_as_standard failed · assertion `left == right` failed: archived tiers price as Standard left: None right: Some(1.0)');
	assert.deepEqual([tests[0].kind, tests[0].test, where(tests[0])], ['test', 'tests::archived_tier_prices_as_standard', ['main.rs:21']]);
	// Output that only has the totals (`cargo test -q`, or the test's own output hidden).
	assert.equal(spotErrors('running 3 tests\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; finished in 0.00s\n')[0].summary, 'Tests failed · 2 passed; 1 failed; 0 ignored');
});

test('Go: a panic with its goroutine trace', () => {
	const errors = spotErrors(captured('go'), 2);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].summary, 'panic in applyDiscount · runtime error: invalid memory address or nil pointer dereference');
	assert.deepEqual(where(errors[0]), ['pricing.go:14 main.applyDiscount', 'checkout.go:9 main.placeOrder', 'main.go:22 main.main']);
	assert.match(errors[0].text, /exit status 2$/);
	assert.equal(spotErrors('panic: the word, in a log line\nstill running\n').length, 0);
});

test('pytest, vitest and jest: each failed test once', () => {
	const pytest = spotErrors(captured('pytest'), 1);
	assert.deepEqual(pytest.map((e) => e.summary), ["test_archived_tier_prices_as_standard failed · TypeError: unsupported operand type(s) for *: 'int' and 'NoneType'", 'test_rounding failed · assert 9.0 == 8']);
	assert.deepEqual(where(pytest[0]), ['pricing.py:9', 'test_pricing.py:9'], 'where it blew up first, then the test');
	// The short summary alone (--tb=no).
	assert.deepEqual(spotErrors('FAILED tests/test_pricing.py::test_rounding - AssertionError: assert 9.0 == 8\n').map((e) => [e.test, e.summary]), [['test_rounding', 'test_rounding failed · AssertionError: assert 9.0 == 8']]);

	const vitest = spotErrors(captured('vitest'), 1);
	assert.deepEqual(vitest.map((e) => e.summary), ['prices an archived tier as standard failed · TypeError in applyDiscount', 'rounds failed · expected 9 to be 8 // Object.is equality']);
	assert.deepEqual(where(vitest[0]), ['pricing.js:4 applyDiscount', 'pricing.test.js:9']);

	const jest = spotErrors(captured('jest'), 1);
	assert.deepEqual(jest.map((e) => e.summary), ['prices an archived tier as standard failed · TypeError in multiplier', 'rounds failed · expect(received).toBe(expected) // Object.is equality']);
	assert.deepEqual(where(jest[0]), ['pricing.js:4 multiplier', 'pricing.test.js:8 Object.applyDiscount']);
	assert.ok(jest.every((e) => e.kind === 'test' && e.runtime === 'node'));
});

test('a non-zero exit code with nothing else to explain it', () => {
	const errors = spotErrors('Building...\nerror CS1002: ; expected\nBuild FAILED.\n', 1);
	assert.deepEqual(errors.map((e) => [e.kind, e.summary]), [['exit', 'Exited with code 1']]);
	assert.match(errors[0].text, /CS1002/, 'the end of the output goes along');
	assert.equal(spotErrors('all fine\n', 0).length, 0);
	assert.equal(spotErrors('stopped by hand\n', null).length, 0);
});

test('what is not an error', () => {
	const calm = ['info: Microsoft.Hosting.Lifetime[14]', '      Now listening on: https://localhost:7241', 'fail: Shop.Api.Payments[0]', '      The gateway took 31 s to answer', 'Error: could not reach the cache, retrying', 'ValidationError: name is required', 'warn: something', ''].join('\n');
	assert.deepEqual(spotErrors(calm, 0), [], 'an error-level log line with no exception and no stack is not a crash');
});

test('reads a stream cut anywhere, colours and all', () => {
	const text = captured('dotnet-api').replace(/^fail:/m, '\x1b[41m\x1b[30mfail\x1b[39m\x1b[22m\x1b[49m:').replace(/\n/g, '\r\n');
	const spotter = new ErrorSpotter();
	const found: SpottedError[] = [];
	for (let i = 0; i < text.length; i += 7) {
		found.push(...spotter.push(text.slice(i, i + 7)));
	}
	assert.equal(found.length, 1, 'found while the program is still running, as soon as the block ends');
	assert.equal(found[0].summary, 'POST /api/orders returned 500 · NullReferenceException in ApplyDiscount');
	assert.ok(!found[0].text.includes('\x1b') && !found[0].text.includes('\r'));

	// A block the output stops in the middle of is closed by flush().
	const quiet = new ErrorSpotter();
	assert.deepEqual(quiet.push(captured('node').split('\nNode.js')[0].trimEnd()), []);
	assert.deepEqual(quiet.flush().map((e) => e.summary), ['TypeError in applyDiscount']);
	assert.deepEqual(quiet.flush(), []);

	assert.equal(stripAnsi('\x1b[32minfo\x1b[0m: ok \x1b]8;;http://x\x07link\x1b]8;;\x07'), 'info: ok link');
	// A progress line rewritten in place counts as what it ends up showing.
	assert.equal(spotErrors('Downloading 10%\rDownloading 100%\rDone\n', 0).length, 0);
});

test('the crash site is the first frame inside the checkout', () => {
	const [e] = spotErrors(captured('dotnet-api'));
	const root = '/Users/rick/src/shop-api/';
	const inside = (file: string): string | null => (file.startsWith(root) ? file.slice(root.length) : null);
	assert.deepEqual(crashSite(e, inside), { path: 'src/Shop.Pricing/PricingService.cs', line: 20, column: null });
	assert.equal(crashSite(e, () => null), null);
	const dep: SpottedError = { ...e, frames: [{ file: 'node_modules/express/lib/router.js', line: 9, column: 1, fn: null }, { file: 'src/app.js', line: 3, column: 5, fn: null }] };
	assert.deepEqual(crashSite(dep, (f) => f), { path: 'src/app.js', line: 3, column: 5 });
});
