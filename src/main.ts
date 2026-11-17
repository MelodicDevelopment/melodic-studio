import './components';

import { bootstrap } from '@melodicdev/core/bootstrap';
import { initTheme } from './shared/theme';

if (import.meta.env.DEV) {
	// Dev builds only: lets a script drive the real window (see src-tauri/src/dev.rs).
	void import('./dev/hooks');
}

await bootstrap({
	target: '#app',
	rootComponent: 'ms-app',
	devMode: import.meta.env.DEV,
	onBefore: () => {
		initTheme();
	},
});
