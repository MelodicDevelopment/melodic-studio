/**
 * What Claude can be asked to review in the checkout on screen, worked out from what the
 * app already knows (the status, the commits History has loaded, the agent that owns the
 * worktree). Nothing here asks git or the host: an offer that turns out to be empty says
 * so when it is clicked.
 */

/**
 * `push`: the commits a push would send. `branch`: everything the branch has that another
 * does not, which is what its pull request carries. `work`: everything in the checkout since
 * a commit, with what is not committed yet and new files.
 */
export type ReviewScope = 'push' | 'branch' | 'work';

export interface ReviewRequest {
	scope: ReviewScope;
	/** `branch`: the branch to compare with (default: the default branch). `work`: the commit the work started at (default: HEAD, so only what is not committed). */
	base?: string;
	/** `work` that is an agent's: everything since its worktree was made. */
	agent?: boolean;
	/** What is reviewed in the user's words, when it has a name of its own ("Pull request #412"). Shown as text only. */
	label?: string;
}

export interface ReviewOffer {
	request: ReviewRequest;
	/** A few words for a button in a narrow strip: "3 uncommitted", "2 to push", "vs main". */
	chip: string;
	/** A card's heading. */
	title: string;
	/** One sentence saying what Claude would look at. */
	detail: string;
}

export interface OfferInput {
	status: {
		branch: string;
		detached: boolean;
		hasCommits: boolean;
		head: string | null;
		upstream: string | null;
		ahead: number;
		defaultBranch: string | null;
		/** Files with uncommitted changes. */
		changed: number;
		/** The tip commit is on no remote. */
		tipUnpushed: boolean;
	} | null;
	/** Commits History has loaded that are on no remote (0 until History was opened). */
	unpushedLoaded: number;
	/** The commit the agent that owns this worktree started from, when one does. */
	agentBase: string | null;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The offers for a checkout, the one closest to what the user is doing first. */
export function reviewOffers(input: OfferInput): ReviewOffer[] {
	const st = input.status;
	if (!st || !st.hasCommits) {
		return [];
	}
	const offers: ReviewOffer[] = [];
	const agent = !!input.agentBase;
	if (agent) {
		// An agent's worktree: one review of everything it did, whether or not that is committed yet.
		if (st.changed || (!!st.head && st.head !== input.agentBase)) {
			offers.push({
				request: { scope: 'work', base: input.agentBase!, agent: true },
				chip: "Agent's work",
				title: "Review this agent's work",
				detail: 'Claude looks for bugs and risks in everything changed here since the agent started, committed or not',
			});
		}
	} else if (st.changed) {
		offers.push({
			request: { scope: 'work' },
			chip: `${st.changed} uncommitted`,
			title: 'Review uncommitted changes',
			detail: `Claude looks for bugs and risks in ${plural(st.changed, 'file')} you have not committed yet`,
		});
	}
	if (st.detached) {
		return offers;
	}
	// `count` is 0 when a push would send something but the number of commits is not known yet.
	const push = st.upstream ? (st.ahead > 0 ? { count: st.ahead } : null) : input.unpushedLoaded || st.tipUnpushed ? { count: input.unpushedLoaded } : null;
	// A branch that was never pushed is measured from the default branch, which for an agent's worktree is its own work again.
	if (push && !(agent && !st.upstream)) {
		offers.push({
			request: { scope: 'push' },
			chip: push.count ? `${push.count} to push` : 'To push',
			title: 'Review before pushing',
			detail: `Claude looks for bugs and risks in ${push.count ? plural(push.count, 'unpushed commit') : 'the unpushed commits'}`,
		});
	}
	// The whole branch: still there once everything is pushed and a pull request is out. Not offered
	// where "to push" already means the same (never pushed), nor in an agent's worktree (its work is the branch).
	const trunk = st.defaultBranch;
	if (!agent && trunk && st.branch && st.branch !== trunk && (st.upstream || !push)) {
		offers.push({
			request: { scope: 'branch' },
			chip: `vs ${trunk}`,
			title: 'Review this branch',
			detail: `Claude looks for bugs and risks in everything ${st.branch} adds to ${trunk}: what its pull request carries`,
		});
	}
	return offers;
}

/** Whether two requests ask for the same review. */
export function sameRequest(a: ReviewRequest | null | undefined, b: ReviewRequest | null | undefined): boolean {
	return !!a && !!b && a.scope === b.scope && (a.base ?? '') === (b.base ?? '');
}

/** What a review covers, for the panel's heading and its line of detail. */
export function describeReview(request: ReviewRequest, range: { against: string; commits: number; files: number } | null): { title: string; detail: string } {
	const files = range ? plural(range.files, 'changed file') : '';
	switch (request.scope) {
		case 'work':
			if (request.agent) {
				return { title: "This agent's work", detail: range ? `${files} since it started at ${range.against}${range.commits ? `, ${plural(range.commits, 'commit')} among them` : ', none of it committed yet'}` : 'Everything changed here since the agent started' };
			}
			return { title: 'Uncommitted changes', detail: range ? `${files}, not committed yet` : 'Everything you have not committed yet' };
		case 'branch':
			return {
				title: request.label || 'This branch',
				detail: range ? `${plural(range.commits, 'commit')} and ${files}, compared with ${range.against}` : 'Everything this branch adds, which is what its pull request carries',
			};
		default:
			return { title: 'Before you push', detail: range ? `${plural(range.commits, 'commit')} and ${files}, compared with ${range.against}` : 'Everything a push would send' };
	}
}

/** Said when there turned out to be nothing to review. */
export function nothingToReview(request: ReviewRequest, range: { against: string; commits: number }): string {
	switch (request.scope) {
		case 'work':
			return request.agent ? 'Nothing here differs from where the agent started.' : 'There is nothing uncommitted with text to review.';
		case 'branch':
			return range.commits ? 'Its commits change no files.' : `This branch has no commits that ${range.against} does not already have.`;
		default:
			return range.commits ? 'The commits waiting to be pushed change no files.' : `This branch has no commits that ${range.against} does not already have.`;
	}
}
