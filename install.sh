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

# GNOME also opens the notification list with Super+V. Remove only that shortcut, keep the
# user's others, and remember the original so uninstall.sh can put it back exactly.
KEY="org.gnome.shell.keybindings toggle-message-tray"
ORIG="${XDG_DATA_HOME:-$HOME/.local/share}/winclip/toggle-message-tray.orig"
cur=$(gsettings get $KEY)
if [[ $cur == *"'<Super>v'"* ]]; then
  [[ -f $ORIG ]] || { mkdir -p "$(dirname "$ORIG")"; printf '%s\n' "$cur" > "$ORIG"; }
  new=$(sed "s/'<Super>v', //; s/, '<Super>v'//; s/'<Super>v'//" <<< "$cur")
  gsettings set $KEY "$new"
fi

VERSION=$(sed -n 's/.*"version-name": "\(.*\)".*/\1/p' metadata.json)
echo "WinClip $VERSION installed. Log out and back in, then press Super+V (Windows key + V)."
