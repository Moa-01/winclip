# Changelog

All notable changes to WinClip. Versions follow [Semantic Versioning](https://semver.org/):
**major** for breaking changes, **minor** for new features or notable fixes, **patch** for small fixes.

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

[1.1.0]: https://github.com/Moa-01/winclip/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Moa-01/winclip/releases/tag/v1.0.0
