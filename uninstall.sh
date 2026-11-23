#!/usr/bin/env bash
# Removes WinClip and gives Super+V back to the notification list.
set -euo pipefail

UUID=winclip@local
cur=$(gsettings get org.gnome.shell enabled-extensions)
gsettings set org.gnome.shell enabled-extensions "$(echo "$cur" | sed "s/, '$UUID'//; s/'$UUID', //; s/'$UUID'//")"
gsettings reset org.gnome.shell.keybindings toggle-message-tray
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"

if [[ ${1:-} == --purge ]]; then
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/winclip"
  echo "Pinned items deleted."
fi
echo "WinClip removed. Log out and back in to finish."
