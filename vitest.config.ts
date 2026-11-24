import { defineConfig } from 'vitest/config';

// Store and component tests (`*.spec.ts`): the real stores against the in-memory demo backend, in a
// pretend browser. The pure modules keep their `*.test.ts` files, which Node runs as they are.
export default defineConfig({
	test: {
		environment: 'happy-dom',
		include: ['src/**/*.spec.ts'],
		setupFiles: ['src/test/setup.ts'],
		restoreMocks: true,
		// Melodic's packages import folders, which a bundler resolves and Node does not: run them through Vite.
		server: { deps: { inline: [/@melodicdev\//] } },
		testTimeout: 10_000,
		coverage: { provider: 'v8', include: ['src/services/**/*.ts', 'src/components/**/*.ts', 'src/shared/**/*.ts'], exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.styles.ts', '**/demo-*.ts', '**/*.d.ts'], reporter: ['text-summary', 'json-summary'] },
	},
});
