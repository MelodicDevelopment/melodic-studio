/**
 * The recording line mapping: what a program recorded while it ran with recording lines in it
 * has to land on the right lines of the code as the user sees it, without them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReplay, cleanSource, depths, leftoverRecording, matchFile, openingStep, parseEvents, stepSource } from './replay.ts';

const PRICING = `namespace Shop.Pricing;

public class PricingService
{
    public decimal ApplyDiscount(Order order)
    {
        StudioReplay.Enter(new { order.CustomerId }); // studio-replay
        var customer = _customers.Get(order.CustomerId);
        StudioReplay.Line(new { customer }); // studio-replay
        var tier = _loyalty.GetTier(customer);
        StudioReplay.Line(new { tier }); // studio-replay
        var subtotal = order.Lines.Sum(l => l.Price * l.Quantity);
        StudioReplay.Line(new { subtotal }); // studio-replay

        try { // studio-replay
        return subtotal * tier.Multiplier;
        } catch (Exception e) { StudioReplay.Throw(e); throw; } // studio-replay
    }
}
`;

const LOYALTY = `def get_tier(customer):
    replay.enter(tier_id=customer.tier_id)  # studio-replay
    tier = TIERS.find(customer.tier_id)
    replay.line(tier=tier)  # studio-replay

    # archived tiers are not offered any more
    result = tier if tier and not tier.archived else None
    replay.ret(result=result)  # studio-replay
    return result
`;

const event = (e: string, fn: string, file: string, line: number, values: Record<string, unknown> = {}): string => JSON.stringify({ event: e, fn, file, line, values });

const RECORDING = [
	event('enter', 'PricingService.ApplyDiscount', '/Users/rick/src/shop.worktrees/investigate-nre/src/Shop.Pricing/PricingService.cs', 7, { CustomerId: '"c_2087"' }),
	event('line', 'PricingService.ApplyDiscount', '/Users/rick/src/shop.worktrees/investigate-nre/src/Shop.Pricing/PricingService.cs', 9, { customer: '{"Id":"c_2087","TierId":"gold-2024"}' }),
	event('enter', 'get_tier', 'src/loyalty.py', 2, { tier_id: "'gold-2024'" }),
	event('line', 'get_tier', 'src/loyalty.py', 4, { tier: 'Tier(id=gold-2024, archived=True)' }),
	'this line is not JSON and is skipped',
	event('return', 'get_tier', 'src/loyalty.py', 8, { result: 'None' }),
	event('line', 'PricingService.ApplyDiscount', '/Users/rick/src/shop.worktrees/investigate-nre/src/Shop.Pricing/PricingService.cs', 11, { tier: 'null' }),
	event('line', 'PricingService.ApplyDiscount', '/Users/rick/src/shop.worktrees/investigate-nre/src/Shop.Pricing/PricingService.cs', 13, { subtotal: 84 }),
	event('throw', 'PricingService.ApplyDiscount', '/Users/rick/src/shop.worktrees/investigate-nre/src/Shop.Pricing/PricingService.cs', 17, { exception: 'NullReferenceException: Object reference not set' }),
	'',
].join('\n');

const COPIES = [
	{ path: 'src/Shop.Pricing/PricingService.cs', text: PRICING },
	{ path: 'src/loyalty.py', text: LOYALTY },
];

test('a file without its recording lines, and where each line went', () => {
	const { lines, toClean, toNext } = cleanSource(PRICING);
	assert.ok(!lines.some((l) => l.includes('studio-replay')));
	assert.equal(lines.length, PRICING.split('\n').length - 6);
	assert.equal(lines[4], '    public decimal ApplyDiscount(Order order)');
	// Real lines keep their place among the real lines.
	assert.equal(lines[toClean[7] - 1], '        var customer = _customers.Get(order.CustomerId);');
	// A recording line points at the statement above it ...
	assert.equal(lines[toClean[8] - 1], '        var customer = _customers.Get(order.CustomerId);');
	assert.equal(lines[toClean[10] - 1], '        var tier = _loyalty.GetTier(customer);');
	// ... the first one in a function at its signature, not at the brace ...
	assert.equal(lines[toClean[6] - 1], '    public decimal ApplyDiscount(Order order)');
	// ... and a wrapper added around a statement at that statement.
	assert.equal(lines[toClean[16] - 1], '        return subtotal * tier.Multiplier;');
	// A "return" is recorded just before the statement, so it uses the line below.
	assert.equal(lines[toNext[14] - 1], '        return subtotal * tier.Multiplier;');
	assert.deepEqual(toNext.filter((_, i) => !PRICING.split('\n')[i].includes('studio-replay')), toClean.filter((_, i) => !PRICING.split('\n')[i].includes('studio-replay')), 'lines of code map the same either way');
	// Windows line endings do not shift anything, and a file with no recording maps onto itself.
	assert.deepEqual(cleanSource(PRICING.replace(/\n/g, '\r\n')).toClean, toClean);
	assert.deepEqual(cleanSource('a\nb\nc').toClean, [1, 2, 3]);
	// A recording line with nothing above it still has somewhere to point.
	assert.deepEqual(cleanSource('x() // studio-replay\ny()').toClean, [1, 1]);
	assert.deepEqual(cleanSource('y()\nx() // studio-replay').toNext, [1, 1], 'and one with nothing below it');
	// Found with a real recording: the call sat above a blank line and a comment, and the return statement is what it means.
	const spaced = cleanSource(['var tier = Find(id);', 'R.Return(new { tier }); // studio-replay', '', '// archived tiers are not offered any more', 'return tier;', '', '# a comment', 'R.Line(new { x }); // studio-replay'].join('\n'));
	assert.equal(spaced.lines[spaced.toNext[1] - 1], 'return tier;');
	assert.equal(spaced.lines[spaced.toClean[1] - 1], 'var tier = Find(id);');
	assert.equal(spaced.lines[spaced.toClean[7] - 1], 'return tier;', 'and upwards past them too');
});

test('events are numbered by their line in the recording', () => {
	const events = parseEvents(RECORDING);
	assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 6, 7, 8, 9], 'the bad line is skipped but still counts');
	assert.deepEqual(events[1].values, [['customer', '{"Id":"c_2087","TierId":"gold-2024"}']]);
	assert.deepEqual(events[6].values, [['subtotal', '84']], 'a value that is not a string is written out');
	assert.equal(parseEvents(event('line', 'f', 'a.py', 1, { big: 'x'.repeat(500) }))[0].values[0][1].length, 201, 'values are cut even if the helper did not');
	assert.deepEqual(parseEvents('{"event":"nope","fn":"f"}\n{"event":"line"}\n[1,2]\n'), []);
});

test('depth comes from the enters and returns', () => {
	assert.deepEqual(depths(parseEvents(RECORDING)), [0, 0, 1, 1, 1, 0, 0, 0]);
	// A function whose enter was never recorded still nests under its caller, and a missed return is put right.
	const loose = parseEvents([event('enter', 'a', 'a', 1), event('line', 'b', 'b', 1), event('line', 'c', 'c', 1), event('line', 'a', 'a', 2), event('return', 'a', 'a', 3), event('enter', 'd', 'd', 1)].join('\n'));
	assert.deepEqual(depths(loose), [0, 1, 2, 0, 0, 0]);
});

test('recorded paths find their copies', () => {
	const copies = ['src/Shop.Pricing/PricingService.cs', 'src/loyalty.py', 'util.py', 'src/a/util.py'];
	assert.equal(matchFile('/Users/rick/wt/src/Shop.Pricing/PricingService.cs', copies), 'src/Shop.Pricing/PricingService.cs');
	assert.equal(matchFile('C:\\src\\wt\\src\\loyalty.py', copies), 'src/loyalty.py');
	assert.equal(matchFile('./src/loyalty.py', copies), 'src/loyalty.py');
	assert.equal(matchFile('/wt/src/a/util.py', copies), 'src/a/util.py', 'the most specific copy');
	assert.equal(matchFile('loyalty.py', copies), 'src/loyalty.py', 'a path relative to where the program ran');
	assert.equal(matchFile('/elsewhere/other.py', copies), null);
	assert.equal(matchFile('', copies), null);
});

test('steps land on the clean code, with cause and crash marked', () => {
	const view = buildReplay(RECORDING, COPIES, { causeSeq: 6, crashSeq: null, notes: { '6': 'An archived tier comes back as None.', '99': 'no such step' } });
	assert.equal(view.steps.length, 8);
	const at = (i: number): string => view.files[view.steps[i].file!][view.steps[i].line - 1].trim();
	assert.equal(at(0), 'public decimal ApplyDiscount(Order order)');
	assert.equal(at(1), 'var customer = _customers.Get(order.CustomerId);');
	assert.equal(at(2), 'def get_tier(customer):');
	assert.equal(at(3), 'tier = TIERS.find(customer.tier_id)');
	assert.equal(at(4), 'return result', 'a return lands on the return statement below its recording line');
	assert.equal(at(5), 'var tier = _loyalty.GetTier(customer);');
	assert.equal(at(7), 'return subtotal * tier.Multiplier;');
	assert.deepEqual(view.steps.map((s) => s.depth), [0, 0, 1, 1, 1, 0, 0, 0]);
	// seq 6 is the fifth step; a throw nobody marked is the crash.
	assert.deepEqual([view.cause, view.crash, view.steps[4].kind, view.steps[7].kind], [4, 7, 'cause', 'crash']);
	assert.equal(view.steps[4].note, 'An archived tier comes back as None.');
	assert.equal(openingStep(view), 4, 'Replay opens on the cause');
	assert.equal(openingStep(buildReplay(RECORDING, COPIES, { causeSeq: null, crashSeq: 9, notes: {} })), 7, 'without a cause, on the crash');
	assert.equal(openingStep(buildReplay('', [], { causeSeq: null, crashSeq: null, notes: {} })), 0);

	// A file nobody copied: the step is still listed, with what the program said about it.
	const lone = buildReplay(event('line', 'main', '/app/main.go', 12, { n: 1 }), [], { causeSeq: null, crashSeq: null, notes: {} });
	assert.deepEqual([lone.steps[0].file, lone.steps[0].fileLabel, lone.steps[0].line], [null, 'main.go', 12]);
	assert.deepEqual(stepSource(lone, 0), []);
});

test('the code shown for a step carries the values recorded so far in that call', () => {
	const view = buildReplay(RECORDING, COPIES, { causeSeq: 6, crashSeq: 9, notes: {} });
	const shown = (i: number): string[] => stepSource(view, i).filter((l) => l.values || l.current).map((l) => `${l.current ? '>' : ' '} ${l.text.trim()}${l.values ? `  [${l.values}]` : ''}`);
	// At the crash: everything recorded in ApplyDiscount, with the current line marked.
	assert.deepEqual(shown(7), [
		'  public decimal ApplyDiscount(Order order)  [CustomerId = "c_2087"]',
		'  var customer = _customers.Get(order.CustomerId);  [customer = {"Id":"c_2087","TierId":"gold-2024"}]',
		'  var tier = _loyalty.GetTier(customer);  [tier = null]',
		'  var subtotal = order.Lines.Sum(l => l.Price * l.Quantity);  [subtotal = 84]',
		'> return subtotal * tier.Multiplier;  [exception = NullReferenceException: Object reference not set]',
	]);
	// Earlier in the same call, what had not happened yet is not shown.
	assert.deepEqual(shown(1), ['  public decimal ApplyDiscount(Order order)  [CustomerId = "c_2087"]', '> var customer = _customers.Get(order.CustomerId);  [customer = {"Id":"c_2087","TierId":"gold-2024"}]']);
	// Inside the callee: only its own values.
	assert.deepEqual(shown(3), ["  def get_tier(customer):  [tier_id = 'gold-2024']", '> tier = TIERS.find(customer.tier_id)  [tier = Tier(id=gold-2024, archived=True)]']);
	// The window is the same whichever step of the function is current, so the code does not jump while scrubbing.
	assert.deepEqual(stepSource(view, 0).map((l) => l.n), stepSource(view, 7).map((l) => l.n));
	assert.equal(stepSource(view, 7)[0].text, 'public class PricingService', 'two lines of context above the first recorded line');
});

test('recording left in a diff is found', () => {
	const diff = (lines: string[]): string => ['--- a/x', '+++ b/x', '@@ -1,2 +1,3 @@', ...lines].join('\n');
	const files = [
		{ path: 'src/LoyaltyService.cs', diff: diff([' var tier = Find(id);', '-return null;', '+return Standard;']) },
		{ path: 'src/PricingService.cs', diff: diff([' var tier = Get();', '+StudioReplay.Line(new { tier }); // studio-replay']) },
		{ path: 'src/Shop.Pricing/StudioReplay.cs', diff: diff(['+internal static class StudioReplay {}']) },
		// Removing a line that mentioned the marker is not leaving it in.
		{ path: 'docs/notes.md', diff: diff(['-about studio-replay', '+about recording']) },
		{ path: 'studio_replay.py', diff: '' },
	];
	assert.deepEqual(leftoverRecording(files), ['src/PricingService.cs', 'src/Shop.Pricing/StudioReplay.cs', 'studio_replay.py']);
	assert.deepEqual(leftoverRecording(files.slice(0, 1)), []);
});
