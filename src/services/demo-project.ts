/** New Project in the browser preview: the real catalog's shape, and a pretend run that prints a few lines. */
import type { ProjectTemplate } from './backend.service';

const node = [
	{ program: 'npx', name: 'Node.js (with npm)', installPage: 'https://nodejs.org', found: true },
	{ program: 'npm', name: 'Node.js (with npm)', installPage: 'https://nodejs.org', found: true },
];
const npmRule = 'lowercase letters, digits and single dashes, starting with a letter (my-app)';
const plainRule = 'letters, digits, dashes and underscores, starting with a letter (my-app)';

const TEMPLATES: ProjectTemplate[] = [
	{
		id: 'melodic-js',
		name: 'Melodic JS',
		description: 'A Melodic app with Melodic Components, through the Melodic CLI.',
		group: 'melodic',
		icon: 'music-notes',
		tools: node,
		options: [
			{ kind: 'flag', id: 'monorepo', label: 'Monorepo (apps/ and libs/ with npm workspaces)', default: false },
			{ kind: 'name', id: 'app', label: "First app's name", default: 'web', when: 'monorepo' },
			{ kind: 'flag', id: 'testing', label: 'Add testing (Vitest)', default: true },
		],
		nameRule: npmRule,
	},
	{
		id: 'melodic-php',
		name: 'Melodic PHP',
		description: 'A Melodic PHP framework project, through its make:project command.',
		group: 'melodic',
		icon: 'music-notes',
		tools: [
			{ program: 'composer', name: 'Composer', installPage: 'https://getcomposer.org/download/', found: true },
			{ program: 'php', name: 'PHP 8.2 or later', installPage: 'https://www.php.net/downloads', found: true },
		],
		options: [{ kind: 'pick', id: 'type', label: 'Kind', choices: [{ value: 'full', label: 'Full: MVC pages and an API' }, { value: 'api', label: 'API only' }, { value: 'mvc', label: 'MVC pages only' }] }],
		nameRule: plainRule,
	},
	{ id: 'angular', name: 'Angular', description: "The Angular CLI's new workspace.", group: 'popular', icon: 'triangle', tools: node.slice(0, 1), options: [{ kind: 'pick', id: 'style', label: 'Styles', choices: [{ value: 'scss', label: 'SCSS' }, { value: 'css', label: 'CSS' }] }, { kind: 'flag', id: 'ssr', label: 'Server-side rendering', default: false }], nameRule: npmRule },
	{ id: 'react', name: 'React', description: 'React with TypeScript, on Vite.', group: 'popular', icon: 'atom', tools: node, options: [], nameRule: npmRule },
	{ id: 'vue', name: 'Vue', description: 'Vue with TypeScript, on Vite.', group: 'popular', icon: 'file-vue', tools: node, options: [], nameRule: npmRule },
	{ id: 'svelte', name: 'Svelte', description: 'Svelte with TypeScript, on Vite.', group: 'popular', icon: 'fire', tools: node, options: [], nameRule: npmRule },
	{ id: 'next', name: 'Next.js', description: 'create-next-app: React, TypeScript, the App Router.', group: 'popular', icon: 'arrow-fat-right', tools: node.slice(0, 1), options: [{ kind: 'flag', id: 'tailwind', label: 'Tailwind CSS', default: true }], nameRule: npmRule },
	{ id: 'laravel', name: 'Laravel', description: 'composer create-project laravel/laravel.', group: 'popular', icon: 'file-php', tools: [{ program: 'composer', name: 'Composer', installPage: 'https://getcomposer.org/download/', found: false }], options: [], nameRule: plainRule },
	{ id: 'dotnet', name: '.NET', description: "dotnet new, from the SDK's own templates.", group: 'popular', icon: 'file-c-sharp', tools: [{ program: 'dotnet', name: 'the .NET SDK', installPage: 'https://dotnet.microsoft.com/download', found: true }], options: [{ kind: 'pick', id: 'kind', label: 'Kind', choices: [{ value: 'webapi', label: 'Web API' }, { value: 'console', label: 'Console app' }] }], nameRule: plainRule },
	{ id: 'rust', name: 'Rust', description: 'cargo new.', group: 'popular', icon: 'gear-six', tools: [{ program: 'cargo', name: 'Rust (rustup)', installPage: 'https://rustup.rs', found: true }], options: [{ kind: 'pick', id: 'kind', label: 'Kind', choices: [{ value: 'bin', label: 'Binary' }, { value: 'lib', label: 'Library' }] }], nameRule: plainRule },
	{ id: 'empty', name: 'Empty folder', description: 'Just the folder; the setup wizard does the rest.', group: 'blank', icon: 'folder-simple', tools: [], options: [], nameRule: plainRule },
];

let stopped = false;

export function demoProject(cmd: string, args: Record<string, unknown>, emit: (event: string, payload: unknown, delay: number) => void): unknown {
	if (cmd === 'project_templates') {
		return TEMPLATES;
	}
	if (cmd === 'project_stop') {
		stopped = true;
		return undefined;
	}
	const request = args.request as { name: string; parent: string; template: string };
	stopped = false;
	const lines: [string, string][] = [
		['step', `Create the project: npx --yes @melodicdev/cli@latest init ${request.name}`],
		['out', 'Melodic project created.'],
		['step', 'Install packages: npm install'],
		['out', 'added 214 packages in 6s'],
	];
	lines.forEach(([kind, text], i) => emit('project-output', { kind, text }, 300 * (i + 1)));
	return new Promise((resolve, reject) => setTimeout(() => (stopped ? reject({ kind: 'error', message: 'Stopped' }) : resolve(`${request.parent}/${request.name}`)), 300 * (lines.length + 1)));
}
