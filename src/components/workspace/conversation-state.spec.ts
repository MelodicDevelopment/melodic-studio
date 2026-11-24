import { expect, test } from 'vitest';
// No store is read here: the dot is a template over the conversation handed to it.
import { render } from '@melodicdev/core/template';
import { stateDot } from './conversation-state';
import type { Conversation, ConvState } from '../../services/workspace.store';

const conversation = (state: ConvState): Conversation => ({ id: 'c1', kind: 'claude', repoId: '/repo', cwd: '/repo', branch: null, title: 'Conversation', titled: true, sessionId: 'x', state, waitingFor: null, lastSaid: '', subagents: [], created: 0, updated: 0, unread: false });

test('a tab’s dot says the conversation’s state in its tooltip, in words a person would use', () => {
	const said = (['starting', 'working', 'waiting', 'idle', 'ended', 'saved'] as ConvState[]).map((state) => {
		const box = document.createElement('div');
		render(stateDot(conversation(state)), box);
		return [state, box.querySelector('span')!.title];
	});
	expect(said).toEqual([
		['starting', 'Starting'],
		['working', 'Working'],
		['waiting', 'Needs you'],
		['idle', 'Ready'],
		['ended', 'Ended'],
		['saved', 'Saved'],
	]);
});
