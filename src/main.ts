import './components';

import { bootstrap } from '@melodicdev/core/bootstrap';
import { initTheme } from './shared/theme';
import { platformReady } from './shared/platform';

// On a web view too old for the app this explains why on screen and never resolves, so nothing below runs.
await platformReady('#app');

await bootstrap({
	target: '#app',
	rootComponent: 'ms-app',
	devMode: import.meta.env.DEV,
	onBefore: () => {
		initTheme();
	},
});
