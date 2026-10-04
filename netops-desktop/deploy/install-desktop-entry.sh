#!/bin/sh
# Install the BlackNet icon set and launcher into the user's XDG data dirs so
# WSLg/GNOME shows the right icon in the taskbar, dock and app switcher.
#
#   ./deploy/install-desktop-entry.sh
#
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/assets/icons"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"

for size in 16 24 32 48 64 128 256 512; do
	src="$ASSETS/blacknet-$size.png"
	[ -f "$src" ] || { echo "missing $src (run: python3 tools/make_icons.py)" >&2; exit 1; }
	dest="$ICONS/${size}x${size}/apps"
	mkdir -p "$dest"
	cp -f "$src" "$dest/blacknet.png"
done

mkdir -p "$APPS"
cat > "$APPS/blacknet.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=BlackNet
GenericName=Private Browser
Comment=BlackNet private desktop browser
Exec=$ROOT/node_modules/electron/dist/electron --no-sandbox --disable-gpu $ROOT
Path=$ROOT
Icon=blacknet
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
StartupWMClass=BlackNet
EOF

# hicolor cache refresh (best effort; not fatal when the tools are absent)
command -v gtk-update-icon-cache >/dev/null 2>&1 &&
	gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo "installed: $APPS/blacknet.desktop"
echo "icons:     $ICONS/*/apps/blacknet.png"