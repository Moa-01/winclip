# WinClip

Clipboard history for GNOME that works like Windows' **Win + V**, with a cleaner look.

Press **Super + V** (the Windows key + V) and a small panel opens with everything you copied recently: text, links, screenshots and images. Click an item and it gets pasted into the app you were using.

<p align="center"><img src="docs/screenshot.png" alt="WinClip popup showing text, a link and an image" width="380"></p>

## Features

- **Super + V** opens the history next to your mouse pointer.
- Keeps your **last 25 copies**, both text and images, with image previews.
- **Click or press Enter to paste** into the app you were in. Terminals get Ctrl + Shift + V automatically.
- **Pin** items (📌) so they stay through **Clear all**, logouts and restarts.
- **Keyboard friendly:** ↑ / ↓ to move, Enter to paste, Delete to remove, Esc to close.
- **Click outside** to close it. Works across multiple monitors.
- Copying the same thing again moves it to the top instead of adding a duplicate.
- Skips copies that password managers mark as secret.
- Light on resources: nothing runs until you copy something or press Super + V.

## Requirements

- **GNOME Shell 46, 47 or 48.** Tested on Ubuntu 24.04 with GNOME 46 on Wayland.
- Nothing else to install. It uses only what GNOME already ships.

> Not for KDE Plasma (it has Klipper built in), Sway, Hyprland or other desktops. WinClip is a GNOME Shell extension.

Check your version with:

```bash
gnome-shell --version
```

## Install

```bash
git clone https://github.com/Moa-01/winclip.git
cd winclip
./install.sh
```

Then **log out and log back in**. On Wayland, GNOME only loads new extensions at login. A full restart isn't needed.

After that, copy something and press **Super + V**.

### What the installer does

1. Copies the extension to `~/.local/share/gnome-shell/extensions/winclip@local/`.
2. Compiles its settings schema (the keyboard shortcut).
3. Adds it to your enabled extensions.
4. Frees up **Super + V**. GNOME normally uses Super + V *and* Super + M to open the notification list, so the installer leaves that on **Super + M** only.

Everything is installed for your user only. No `sudo`.

### Update

```bash
cd winclip
git pull
./install.sh
```

Then log out and back in.

## Usage

| Action | How |
|---|---|
| Open / close history | **Super + V** |
| Paste an item | Click it, or select it and press **Enter** |
| Move between items | **↑ / ↓** |
| Remove an item | **Delete**, or the **✕** button |
| Pin / unpin | The **📌** button |
| Remove everything except pins | **Clear all** |
| Close without pasting | **Esc**, or click anywhere outside the panel |

### When items go away

Like Windows, unpinned history only lasts for your session:

| Event | What's removed |
|---|---|
| Log out / restart | All unpinned items |
| More than 25 items | The oldest unpinned item |
| **Clear all** | All unpinned items |
| **✕** on an item | That item, pinned or not |
| Locking the screen | Nothing. History is kept |

Pinned items are saved to disk and come back after a restart.

### Change the shortcut

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/winclip@local/schemas \
  set org.gnome.shell.extensions.winclip toggle-history "['<Super><Shift>v']"
```

It usually applies right away. If it doesn't, log out and back in.

## How it works

WinClip is a GNOME Shell extension, a small piece of JavaScript that runs inside GNOME Shell itself (`extension.js`, about 330 lines).

**Why an extension and not a normal app?** On Wayland, regular apps aren't allowed to read the clipboard in the background, which protects you from apps spying on your copies. GNOME doesn't offer the extra protocol that some other desktops use for clipboard managers. The only place that can see every copy on GNOME is the shell itself, so WinClip lives there.

1. **Watching copies.** WinClip listens for GNOME's "clipboard owner changed" signal. When you copy something it reads the content once:
   - **Text** (anything that offers plain text) is stored as text.
   - **Images** (PNG preferred, otherwise any image format) are stored as the raw image bytes when the copy has no text version. This covers screenshots and "Copy image" in browsers.
   - **An image file copied in the Files app** is loaded from disk and shown as the picture.
   - **Other copied files** are stored as their file paths.
2. **History.** Items live in memory, newest first, capped at 25. Each one gets a fingerprint (the text itself, or an MD5 hash of the image) so repeat copies move to the top instead of piling up.
3. **The panel.** Super + V builds the panel with GNOME's own toolkit (St), places it near the pointer and takes keyboard focus. A transparent layer covers every monitor so a click outside closes it. When it closes, the whole panel is destroyed, so nothing stays around while it's hidden.
4. **Pasting.** Clicking an item puts it back on the clipboard. WinClip then waits a moment for focus to return to your app and presses **Ctrl + V** with a virtual keyboard. For terminals it presses **Ctrl + Shift + V**; a terminal is spotted by its window class name (`gnome-terminal`, `kitty`, `alacritty`, `wezterm`, `foot`, `konsole`, `tilix`, `ghostty`, `terminator`, `ptyxis`, …).
5. **Pins.** Pinned items are written to `~/.local/share/winclip/pinned.json`, with images stored as base64. The folder is readable only by you (`0700`). Nothing else is ever written to disk.

### Memory and disk use

- **Per-item limit:** anything over **4 MB** is skipped, the same limit Windows uses.
- **History limit:** **25 items** maximum.
- **Image previews:** small thumbnails (at most 300 × 170 px), decoded once per image and reused. Full-size images are never decoded.
- **Measured memory:** 25 full-screen screenshots in history added about 45 MB to GNOME Shell's memory, which is the worst case. A text-only history is a few kilobytes.
- **Disk:** the extension itself is about 40 KB. The only file it writes is the pins file.

## Limitations

- **GNOME only.** No support for KDE, Sway, Hyprland, Xfce and so on.
- **Tested only on GNOME 46 / Ubuntu 24.04 / Wayland.** GNOME 47 and 48 should work but haven't been tested. X11 sessions should work too, also untested.
- **Log out after installing or updating.** Wayland can't reload GNOME Shell while you're logged in.
- **Opens near the mouse, not the text cursor.** Windows opens it at the text cursor, but Wayland doesn't tell extensions where that is.
- **One format per item.** Each copy is stored as plain text *or* an image. Formatting (bold, links in rich text, spreadsheet cells) is lost; pasting gives plain text. When a copy offers both text and an image (common in office apps), the text is kept.
- **Copied files paste as content, not as files.** A copied image file pastes as the image, and other copied files paste as their paths. Pasting a history item into the Files app won't copy the file itself.
- **Auto-paste presses Ctrl + V** (or Ctrl + Shift + V in recognised terminals). Apps with a different paste shortcut, or terminals whose window class isn't in the list, won't paste automatically. The item is still on the clipboard, so paste it yourself.
- **Password safety depends on the password manager.** Copies are skipped only when the app marks them as secret (`x-kde-passwordManagerHint`, used by KeePassXC and others). Passwords from apps that don't do this stay in history until you log out, unless you remove them with ✕.
- **Pins are stored unencrypted** in `~/.local/share/winclip/pinned.json`. Don't pin secrets.
- **Dark theme only.**
- **Not included from Windows 11:** search, the emoji / GIF / symbol tabs, and cloud sync between devices.
- **Not on extensions.gnome.org.** Install it from this repo.

## Troubleshooting

**Super + V does nothing**

1. Make sure you logged out and back in after installing.
2. Check that it's running:
   ```bash
   gnome-extensions info winclip@local
   ```
   `State` should be `ACTIVE` (older GNOME versions show `ENABLED`). If it's `ERROR`, look at the logs:
   ```bash
   journalctl --user -b | grep -iE "winclip|JS ERROR"
   ```
3. Make sure nothing else uses Super + V:
   ```bash
   gsettings get org.gnome.shell.keybindings toggle-message-tray   # should be ['<Super>m']
   ```

**An item didn't paste**

The app probably uses a different paste shortcut. The item is already on the clipboard, so press that app's paste shortcut.

**An image shows as the word "Image"**

GNOME couldn't decode a preview for that format. Pasting it still works.

## Uninstall

```bash
./uninstall.sh            # remove WinClip, give Super+V back to notifications
./uninstall.sh --purge    # same, and also delete your pinned items
```

Then log out and back in.

## Files

| File | Purpose |
|---|---|
| `extension.js` | All the logic: watching copies, history, panel, pasting |
| `stylesheet.css` | The look |
| `metadata.json` | Extension name, ID and supported GNOME versions |
| `schemas/` | The Super + V shortcut setting |
| `install.sh` / `uninstall.sh` | Set up / remove for the current user |

## License

[MIT](LICENSE)
