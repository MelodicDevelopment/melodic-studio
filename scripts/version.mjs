// The app's version lives in three files that must agree: package.json,
// src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
//
//   node scripts/version.mjs               print the version, and fail if the files disagree
//   node scripts/version.mjs set 0.2.0     write a new version to all three (and the lock files)
//   node scripts/version.mjs check v0.2.0  fail unless that tag is the current version (used by the release workflow)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = (name) => join(root, name);
const read = (name) => readFileSync(file(name), 'utf8');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The `version = "…"` line of the [package] table (the first one in the file). */
const CARGO = /^version = "([^"]+)"/m;
/** The app's own entry in Cargo.lock. */
const LOCK = /(\[\[package\]\]\nname = "melodic-studio"\nversion = ")([^"]+)(")/;

function versions() {
	return {
		'package.json': JSON.parse(read('package.json')).version,
		'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
		'src-tauri/Cargo.toml': CARGO.exec(read('src-tauri/Cargo.toml'))?.[1],
	};
}

function current() {
	const found = versions();
	const unique = [...new Set(Object.values(found))];
	if (unique.length !== 1 || !unique[0]) {
		throw new Error(`The version files disagree:\n${Object.entries(found).map(([f, v]) => `  ${f}: ${v}`).join('\n')}\nFix with: npm run bump -- set <version>`);
	}
	return unique[0];
}

/** Replace only the version value, leaving the file's own formatting alone. */
function replaceJsonVersion(name, version) {
	const text = read(name);
	const next = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
	writeFileSync(file(name), next);
}

function set(version) {
	if (!SEMVER.test(version)) {
		throw new Error(`"${version}" is not a version like 1.2.3`);
	}
	replaceJsonVersion('package.json', version);
	replaceJsonVersion('src-tauri/tauri.conf.json', version);
	writeFileSync(file('src-tauri/Cargo.toml'), read('src-tauri/Cargo.toml').replace(CARGO, `version = "${version}"`));

	// package-lock.json names the root package's version twice.
	const lock = JSON.parse(read('package-lock.json'));
	lock.version = version;
	if (lock.packages?.['']) {
		lock.packages[''].version = version;
	}
	writeFileSync(file('package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

	const cargoLock = read('src-tauri/Cargo.lock');
	if (LOCK.test(cargoLock)) {
		writeFileSync(file('src-tauri/Cargo.lock'), cargoLock.replace(LOCK, `$1${version}$3`));
	}
	console.log(`Version is now ${current()}`);
}

try {
	const [command, value] = process.argv.slice(2);
	if (command === 'set') {
		set(value ?? '');
	} else if (command === 'check') {
		const version = current();
		if ((value ?? '').replace(/^v/, '') !== version) {
			throw new Error(`Tag ${value} does not match the app version ${version}. Run: npm run bump -- set ${(value ?? '').replace(/^v/, '')}, commit, and tag that commit.`);
		}
		console.log(`Tag ${value} matches version ${version}`);
	} else {
		console.log(current());
	}
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
