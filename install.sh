#!/usr/bin/env bash
# Installs WinClip for the current user. Safe to run again to update.
set -euo pipefail

UUID=winclip@local
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
cd "$(dirname "$0")"

command -v gnome-shell >/dev/null || { echo "WinClip needs GNOME Shell." >&2; exit 1; }

mkdir -p "$DEST/schemas"
cp extension.js paste-helper.py stylesheet.css metadata.json "$DEST/"
cp schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"

# Turn it on. A running Wayland session can't load a brand-new extension,
# so write the setting directly; it takes effect at next login.
gsettings set org.gnome.shell disable-user-extensions false
cur=$(gsettings get org.gnome.shell enabled-extensions)
if [[ $cur != *"'$UUID'"* ]]; then
  if [[ $cur == "@as []" || $cur == "[]" ]]; then new="['$UUID']"; else new="${cur%]}, '$UUID']"; fi
  gsettings set org.gnome.shell enabled-extensions "$new"
fi

# GNOME uses Super+V for the notification list; keep that on Super+M only.
gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"

echo "WinClip installed. Log out and back in, then press Super+V (Windows key + V)."
