#!/usr/bin/env bash
# Adds Watchroom to your applications menu (and "Open with" for video files). Undo: delete the .desktop file.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/applications/watchroom.desktop"
mkdir -p "$(dirname "$DEST")"
cat > "$DEST" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Watchroom
Comment=Watch your videos together with friends, in sync
Exec="$NODE" "$ROOT/apps/desktop/launch.mjs" %f
Icon=$ROOT/apps/desktop/assets/icon.png
Terminal=false
Categories=AudioVideo;Video;Player;
MimeType=video/x-matroska;video/mp4;video/x-msvideo;video/quicktime;video/webm;video/mp2t;video/x-ms-wmv;video/x-flv;video/mpeg;
StartupWMClass=Watchroom
DESKTOP
chmod 644 "$DEST"
command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$DEST")" >/dev/null 2>&1 || true
echo "Installed: $DEST"
