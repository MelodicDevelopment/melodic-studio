#!/bin/sh
# Cargo runner for macOS (see .cargo/config.toml). Cargo passes the built executable and its arguments.
#
# A bare executable shows in the Dock under its file name ("melodic-studio"). Wrapping the app binary
# in a minimal .app bundle next to it gives dev builds the product's name and icon, as a release
# bundle has. Anything else cargo runs (unit tests, other binaries) is executed untouched.
BIN="$1"
shift
if [ "$(basename "$BIN")" != "melodic-studio" ]; then
	exec "$BIN" "$@"
fi

NAME="Melodic Studio"
APP="$(dirname "$BIN")/$NAME.app"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -f "$BIN" "$APP/Contents/MacOS/$NAME"
cp -f "$HERE/icons/icon.icns" "$APP/Contents/Resources/icon.icns" 2>/dev/null
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>$NAME</string>
	<key>CFBundleDisplayName</key><string>$NAME</string>
	<key>CFBundleExecutable</key><string>$NAME</string>
	<key>CFBundleIdentifier</key><string>dev.melodic.studio</string>
	<key>CFBundleIconFile</key><string>icon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
exec "$APP/Contents/MacOS/$NAME" "$@"
