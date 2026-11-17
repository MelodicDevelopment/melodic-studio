#!/bin/sh
# cargo runner for macOS (see .cargo/config.toml): runs the app through a hard link named "Melodic Studio",
# so the Dock shows that instead of "melodic-studio". Anything else (test binaries) runs untouched.
exe="$1"
shift
if [ "$(basename "$exe")" = "melodic-studio" ]; then
	named="$(dirname "$exe")/Melodic Studio"
	if ln -f "$exe" "$named" 2>/dev/null || cp -f "$exe" "$named"; then
		exe="$named"
	fi
fi
exec "$exe" "$@"
