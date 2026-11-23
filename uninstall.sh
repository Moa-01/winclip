#!/usr/bin/env bash
# Removes WinClip and gives Super+V back to the notification list.
set -euo pipefail

UUID=winclip@local
gnome-extensions disable "$UUID" 2>/dev/null || true  # stop it now, not only at next login
cur=$(gsettings get org.gnome.shell enabled-extensions)
gsettings set org.gnome.shell enabled-extensions "$(echo "$cur" | sed "s/, '$UUID'//; s/'$UUID', //; s/'$UUID'//")"
ORIG="${XDG_DATA_HOME:-$HOME/.local/share}/winclip/toggle-message-tray.orig"
if [[ -f $ORIG ]]; then
  gsettings set org.gnome.shell.keybindings toggle-message-tray "$(cat "$ORIG")"
  rm "$ORIG"
fi
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"

if [[ ${1:-} == --purge ]]; then
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/winclip"
  echo "Pinned items deleted."
fi
echo "WinClip removed. Log out and back in to finish."
