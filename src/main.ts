import './components';

import { bootstrap } from '@melodicdev/core/bootstrap';
import { initTheme } from './shared/theme';

await bootstrap({
	target: '#app',
	rootComponent: 'ms-app',
	devMode: import.meta.env.DEV,
	onBefore: () => {
		initTheme();
	},
});
