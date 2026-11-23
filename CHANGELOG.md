# Changelog

All notable changes to WinClip. Versions follow [Semantic Versioning](https://semver.org/):
**major** for breaking changes, **minor** for new features, **patch** for fixes.

## [1.2.1] - 2026-11-23

### Changed
- The popup now has a thin border, so it stays visible on top of a window with the same background color (for example a black terminal when WinClip uses your terminal's colors).

## [1.2.0] - 2026-11-23

### Added
- **Search:** start typing in the popup to filter the list. Enter pastes the top match, ↓ moves into the results, ↑ from the first result goes back to the search box.
- **Alt+1 to Alt+9** paste the 1st to 9th item in the list as shown (search results included).
- **Colors from your GNOME Terminal profile:** its background, text and cursor color (as the highlight). Without custom terminal colors, WinClip follows GNOME's **light / dark** setting, so there's a light theme now.

### Fixed
- Temporary files left behind if GNOME Shell crashed mid-preview are now cleared when WinClip starts.

## [1.1.1] - 2026-11-23

Fixes from a full code review.

### Fixed
- **The paste helper could be killed by any X11 app**, wiping a file you'd just pasted from the clipboard. It now ignores X11 errors from requestors that disappear mid-request.
- **Huge copies could stall or crash GNOME Shell.** The 4 MB limit was checked only after the whole copy had been read in (a 200 MB copy stalled the shell for 0.8 s). Copies are now read in the background and the read stops at 4 MB.
- **Image previews could freeze the shell.** A small file with huge dimensions (12000×12000 px) froze it for 0.4–0.8 s and used about 600 MB. Previews are now made entirely in the background, and images over about 36 megapixels get none. Measured: 402 ms → 1 ms.
- **A file disguised as an image (for example a link to `/dev/zero` named `x.png`) made the shell read forever.** Only regular files are read now.
- **Pins weren't always private.** The pins file is now `0600` in a `0700` folder, whatever the system's default permissions. Pins are also saved in the background, with errors logged instead of breaking the popup.
- **Super+V didn't close the popup.** It does now.
- **With 25 items pinned, new copies were silently dropped.** Pins no longer count toward the 25-item limit.
- **Copying a file could hide a pinned text item** equal to its path. Pinned items are never touched.
- **History stayed in memory after you turned WinClip off.** WinClip now stays enabled on the lock screen (so history still survives a lock), and turning it off really clears everything.
- Non-Latin text could take twice the 4 MB limit. The limit is now in bytes, and long text is hashed instead of copied for duplicate checks.
- Timers from two quick file pastes could interfere with each other.
- `uninstall.sh` now stops WinClip right away instead of leaving it running until logout.
- README corrections.

### Changed
- Slimmer, quieter scrollbar.

## [1.1.0] - 2026-11-23

Fixes from community feedback.

### Fixed
- **The shell could freeze when something was copied.** Image files were read synchronously inside GNOME Shell, and any URI scheme was accepted, so an `http://` image link or a slow network mount could block the whole desktop. Now only local `file://` URIs are treated as files, and they're read in the background. Other links are kept as plain text.
- **Paste could land in the wrong window.** If focus moved while the paste was being prepared, Ctrl+V went to whichever window was focused. WinClip now only types into the window you opened it from. Otherwise the item just stays on the clipboard.
- **Pinned items could be wiped.** A damaged `pinned.json` was treated as empty and overwritten by the next pin. It's now moved aside as `pinned.json.broken-<date>` with a warning in the log.
- **Some file copies were silently dropped.** A file name with an invalid `%` sequence made the copy fail. These are now kept.
- **The installer overwrote your notification shortcut.** It now removes only Super+V, keeps your other shortcuts, and `uninstall.sh` restores exactly what you had.

### Added
- Version number, shown in the Extensions app and by `gnome-extensions info winclip@local`.
- This changelog.

## [1.0.0] - 2026-11-23

First release.

- Super+V clipboard history like Windows: last 25 text and image copies, 4 MB per item.
- Click or Enter pastes into the app you were in (Ctrl+Shift+V in terminals).
- Pin items to keep them through Clear all and restarts.
- Image previews, keyboard navigation, click outside to close, multi-monitor.
- Files copied in the Files app paste back as real files in Files, on the desktop, and in Slack, browsers and other apps.
- Skips copies password managers mark as secret.
- GNOME 46 to 50.

[1.2.1]: https://github.com/Moa-01/winclip/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Moa-01/winclip/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Moa-01/winclip/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Moa-01/winclip/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Moa-01/winclip/releases/tag/v1.0.0
