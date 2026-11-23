import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MAX = 25; // like Windows: 25 items (pins don't count), 4 MB per item
const MAX_BYTES = 4 * 1024 * 1024;
// Bigger images get no preview: a 4 MB PNG can be 23000×23000 px, ~2 GB once decoded.
const MAX_PIXELS = 36e6;
const PNG = 'image/png';
const CB = St.ClipboardType.CLIPBOARD;
const CLIPBOARD = Meta.SelectionType.SELECTION_CLIPBOARD;
const TEXT_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING'];
const STORE_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'winclip']);
const STORE = GLib.build_filenamev([STORE_DIR, 'pinned.json']);
// terminals paste with Ctrl+Shift+V
const TERMINALS = /term|kitty|alacritty|wezterm|foot|konsole|tilix|ghostty|terminator|ptyxis|herdr/i;

// GNOME 48 deprecated St.BoxLayout's `vertical` for `orientation` (which 46/47 lack): use whichever exists
const VERTICAL = GObject.Object.find_property.call(St.BoxLayout, 'orientation')
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

// Popup colors when the terminal doesn't provide its own: GNOME light / dark
const DEFAULT_COLORS = {
    dark: {bg: [30, 31, 36], fg: [236, 236, 241], accent: [143, 184, 255]},
    light: {bg: [250, 250, 251], fg: [29, 29, 32], accent: [53, 132, 228]},
};

function parseColor(s) {
    let m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m)
        return m.slice(1, 4).map(Number);
    m = s.match(/^#([0-9a-f]{6})$/i);
    return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null;
}

const luma = c => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

function keyOf(item) {
    return item.text !== undefined
        ? `t:${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, item.text, -1)}`
        : `i:${GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, item.png)}`;
}

function preview(text) {
    const t = text.slice(0, 2000).replace(/^\s+/, '').split('\n').slice(0, 4).join('\n');
    return t.length > 280 ? `${t.slice(0, 280)}…` : t;
}

export default class WinClip extends Extension {
    enable() {
        this._clip = St.Clipboard.get_default();
        this._timers = new Set();
        this._cancel = new Gio.Cancellable();
        // everything in our runtime folder is temporary: clear leftovers from a crashed session
        try {
            const tmp = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'winclip']);
            const files = Gio.File.new_for_path(tmp).enumerate_children('standard::name', 0, null);
            for (let info; (info = files.next_file(null));)
                GLib.unlink(GLib.build_filenamev([tmp, info.get_name()]));
        } catch {} // no folder yet
        this._items = this._load();
        this._vk = (global.stage.context?.get_backend() ?? Clutter.get_default_backend()).get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._sel = global.display.get_selection();
        this._selId = this._sel.connect('owner-changed', (_s, type) => {
            if (type === CLIPBOARD)
                this._onCopy();
        });
        // metadata.json keeps us enabled on the lock screen (so history survives a lock, like
        // Windows); just make sure the popup isn't left open behind it.
        this._modeId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked)
                this._close();
        });
        Main.wm.addKeybinding('toggle-history', this.getSettings(), Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this._toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-history');
        this._sel.disconnect(this._selId);
        Main.sessionMode.disconnect(this._modeId);
        this._cancel.cancel();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._close();
        if (this._cssFile) {
            this._theme?.unload_stylesheet(this._cssFile);
            this._cssFile.delete(null);
        }
        this._clip = this._items = this._vk = this._sel = this._timers = this._cancel = null;
        this._css = this._cssFile = this._theme = null;
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _cancelLater(id) {
        if (this._timers?.delete(id))
            GLib.source_remove(id);
    }

    // ---- history ----

    _onCopy() {
        const types = this._clip.get_mimetypes(CB);
        if (types.includes('x-kde-passwordManagerHint'))
            return; // password managers flag secrets; never record them, like Windows
        const text = TEXT_TYPES.find(t => types.includes(t));
        const img = types.includes(PNG) ? PNG : types.find(t => t.startsWith('image/'));
        if (img && !text) {
            this._read(img, png => this._add({png, mime: img}));
        } else if (types.includes('text/uri-list')) {
            this._read('text/uri-list', b => this._addFile(b));
        } else if (text) {
            this._read(text, b => {
                const t = new TextDecoder().decode(b.toArray());
                if (t.trim())
                    this._add({text: t});
            });
        }
    }

    // Reads one clipboard format asynchronously, and never more than MAX_BYTES + 1, so an
    // oversized copy is dropped without being pulled into the shell. Cancelled on disable.
    _read(mime, cb) {
        const out = Gio.MemoryOutputStream.new_resizable();
        this._sel.transfer_async(CLIPBOARD, mime, MAX_BYTES + 1, out, this._cancel, (sel, res) => {
            try {
                sel.transfer_finish(res);
                out.close(null);
            } catch {
                return; // cancelled or the source went away
            }
            const bytes = out.steal_as_bytes();
            if (this._items && bytes.get_size() > 0 && bytes.get_size() <= MAX_BYTES)
                cb(bytes);
        });
    }

    // Files copied in the Files app: one image shows as the picture, anything else as its path.
    // Either way it keeps the file list, so pasting gives the files back (Files app, desktop).
    // Only local file:// URIs count as files (http:// etc. would make Gio fetch over the network),
    // only regular files are read (not /dev/zero or a FIFO named *.png), and the read is async
    // so a slow disk or network mount can't freeze the shell.
    _addFile(bytes) {
        const uris = new TextDecoder().decode(bytes.toArray()).split(/\r?\n/).filter(u => u && !u.startsWith('#'));
        if (!uris.length)
            return;
        if (!uris.every(u => u.startsWith('file://'))) {
            this._add({text: uris.join('\n')}); // links, not files: keep as plain text
            return;
        }
        const ext = uris[0].match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i)?.[1].toLowerCase();
        if (uris.length !== 1 || !ext) {
            this._addPaths(uris);
            return;
        }
        const file = Gio.File.new_for_uri(uris[0]);
        file.query_info_async('standard::type,standard::size', 0, GLib.PRIORITY_DEFAULT, this._cancel, (_f, res) => {
            try {
                const info = file.query_info_finish(res);
                if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_BYTES)
                    throw new Error('not a usable image file');
            } catch {
                this._addPaths(uris);
                return;
            }
            file.load_contents_async(this._cancel, (_f2, res2) => {
                try {
                    const [, data] = file.load_contents_finish(res2);
                    const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext.replace('jpg', 'jpeg')}`;
                    this._add({png: new GLib.Bytes(data), mime, path: file.get_path(), uris});
                } catch {
                    this._addPaths(uris);
                }
            });
        });
    }

    _addPaths(uris) {
        // Gio decodes %-escapes itself and never throws on bad ones
        this._add({text: uris.map(u => Gio.File.new_for_uri(u).get_path() ?? u).join('\n'), uris});
    }

    _add(item) {
        if (!this._items)
            return; // callback landed after disable
        // A file copy offers both the file and its path as text; keep only the picture.
        const asPath = t => t?.trim().startsWith('file://') ? Gio.File.new_for_uri(t.trim()).get_path() : t?.trim();
        if (item.text !== undefined && this._items.some(i => i.path && i.path === asPath(item.text)))
            return;
        if (item.path)
            this._items = this._items.filter(i => i.pinned || i.text === undefined || asPath(i.text) !== item.path);
        item.key = keyOf(item);
        const dup = this._items.findIndex(i => i.key === item.key);
        if (dup >= 0)
            item.pinned = this._items.splice(dup, 1)[0].pinned;
        this._items.unshift(item);
        // Cap the unpinned history only, so pinning lots of items never blocks new copies.
        const unpinned = this._items.filter(i => !i.pinned);
        if (unpinned.length > MAX) {
            const drop = new Set(unpinned.slice(MAX));
            this._items = this._items.filter(i => !drop.has(i));
        }
        if (item.png)
            this._makeThumb(item);
        this._render();
    }

    // Like Windows: unpinned history dies with the session, pinned items survive.
    // Saved asynchronously, privately (0600 in a 0700 folder), one write at a time.
    // ponytail: images inlined as base64 in one JSON file; fine for a handful of pins.
    _save() {
        if (this._saving) {
            this._saveAgain = true;
            return;
        }
        this._saving = true;
        const pinned = this._items.filter(i => i.pinned).map(i => i.text !== undefined
            ? {text: i.text, uris: i.uris}
            : {png: GLib.base64_encode(i.png.toArray()), mime: i.mime, uris: i.uris, path: i.path});
        const done = () => {
            this._saving = false;
            if (this._saveAgain && this._items) {
                this._saveAgain = false;
                this._save();
            }
        };
        try {
            GLib.mkdir_with_parents(STORE_DIR, 0o700);
            Gio.File.new_for_path(STORE_DIR).set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);
            Gio.File.new_for_path(STORE).replace_contents_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(pinned))), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        console.warn(`winclip: could not save pinned items: ${e.message}`);
                    }
                    done();
                });
        } catch (e) {
            console.warn(`winclip: could not save pinned items: ${e.message}`);
            done();
        }
    }

    _load() {
        let data;
        try {
            [, data] = GLib.file_get_contents(STORE);
        } catch {
            return []; // no pins yet
        }
        try {
            const items = JSON.parse(new TextDecoder().decode(data)).map(i => {
                const item = typeof i.text === 'string'
                    ? {text: i.text, uris: i.uris}
                    : {png: new GLib.Bytes(GLib.base64_decode(i.png)), mime: i.mime, uris: i.uris, path: i.path};
                return {...item, key: keyOf(item), pinned: true};
            });
            items.filter(i => i.png).forEach(i => this._makeThumb(i));
            return items;
        } catch (e) {
            // move it aside so the next pin can't overwrite it; it can be fixed by hand
            const bad = `${STORE}.broken-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`;
            GLib.rename(STORE, bad);
            console.warn(`winclip: pinned items unreadable (${e.message}); kept as ${bad}`);
            return [];
        }
    }

    // ---- previews ----

    // Small preview, made once per image, entirely off the main thread. The image size is read
    // from its header first (gdk-pixbuf stops after the header), so huge images are skipped
    // instead of decoded. That call needs a file: a private RAM-backed temp file, deleted right after.
    _makeThumb(item) {
        if (item.thumb !== undefined)
            return;
        item.thumb = null; // "Image" placeholder until (unless) the preview is ready
        const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'winclip', `thumb-${GLib.uuid_string_random()}`]);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            GLib.file_set_contents(path, item.png.toArray());
        } catch {
            return;
        }
        GdkPixbuf.Pixbuf.get_file_info_async(path, this._cancel, (_s, res) => {
            GLib.unlink(path);
            let w = 0, h = 0;
            try {
                [, w, h] = GdkPixbuf.Pixbuf.get_file_info_finish(res);
            } catch {
                return;
            }
            if (!w || w * h > MAX_PIXELS)
                return;
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                Gio.MemoryInputStream.new_from_bytes(item.png), 300, 170, true, this._cancel, (_s2, res2) => {
                    try {
                        const pb = GdkPixbuf.Pixbuf.new_from_stream_finish(res2);
                        const content = St.ImageContent.new_with_preferred_size(pb.width, pb.height);
                        const args = [pb.read_pixel_bytes(), pb.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                            pb.width, pb.height, pb.rowstride];
                        // GNOME 48+ wants the Cogl context first
                        const cogl = global.stage.context?.get_backend().get_cogl_context();
                        content.set_bytes(...(cogl ? [cogl, ...args] : args));
                        item.thumb = content;
                        if (item.slot)
                            item.slot.child = this._thumbActor(item);
                    } catch (e) {
                        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            console.warn(`winclip: no preview: ${e.message}`);
                    }
                });
        });
    }

    _thumbActor(item) {
        if (!item.thumb)
            return new St.Label({text: 'Image', style_class: 'winclip-text'});
        const [, w, h] = item.thumb.get_preferred_size();
        return new St.Widget({content: item.thumb, width: w, height: h});
    }

    // ---- colors ----

    // Colors follow the GNOME Terminal profile when it has its own colors (background, text, and
    // the cursor color as the accent); otherwise GNOME's light/dark setting.
    _colors() {
        const scheme = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme');
        const c = {...DEFAULT_COLORS[scheme === 'prefer-dark' ? 'dark' : 'light']};
        try {
            const src = Gio.SettingsSchemaSource.get_default();
            if (!src.lookup('org.gnome.Terminal.ProfilesList', true) || !src.lookup('org.gnome.Terminal.Legacy.Profile', true))
                return c;
            const id = new Gio.Settings({schema_id: 'org.gnome.Terminal.ProfilesList'}).get_string('default');
            const p = new Gio.Settings({
                schema_id: 'org.gnome.Terminal.Legacy.Profile', path: `/org/gnome/terminal/legacy/profiles:/:${id}/`,
            });
            const bg = parseColor(p.get_string('background-color'));
            const fg = parseColor(p.get_string('foreground-color'));
            if (!p.get_boolean('use-theme-colors') && bg && fg && Math.abs(luma(bg) - luma(fg)) > 0.3) {
                c.bg = bg;
                c.fg = fg;
            }
            const accent = parseColor(p.get_string('cursor-background-color'));
            if (p.get_boolean('cursor-colors-set') && accent && Math.abs(luma(accent) - luma(c.bg)) > 0.2)
                c.accent = accent;
        } catch {} // unusual terminal settings: keep the defaults
        return c;
    }

    // Writes the colors as a small stylesheet layered over stylesheet.css (which keeps the layout),
    // reloading it only when the colors actually changed.
    _applyTheme() {
        const {bg, fg, accent} = this._colors();
        const a = (c, o) => `rgba(${c.join(', ')}, ${o})`;
        const css = `
#winclip { background-color: ${a(bg, 0.97)}; color: ${a(fg, 1)}; border-color: ${a(fg, 0.25)}; }
#winclip .winclip-clear { color: ${a(accent, 1)}; }
#winclip .winclip-clear:hover, #winclip .winclip-clear:focus { background-color: ${a(accent, 0.14)}; }
#winclip .winclip-item { background-color: ${a(fg, 0.045)}; border-color: ${a(fg, 0.04)}; }
#winclip .winclip-item:hover { background-color: ${a(fg, 0.085)}; }
#winclip .winclip-pick:focus { border-color: ${a(accent, 0.9)}; background-color: ${a(accent, 0.08)}; }
#winclip .winclip-act { color: ${a(fg, 0.35)}; }
#winclip .winclip-act:hover { background-color: ${a(fg, 0.1)}; color: ${a(fg, 1)}; }
#winclip .winclip-act.pinned { color: ${a(accent, 1)}; }
#winclip .winclip-search { background-color: ${a(fg, 0.06)}; color: ${a(fg, 1)}; caret-color: ${a(fg, 1)}; selection-background-color: ${a(accent, 0.35)}; selected-color: ${a(fg, 1)}; }
#winclip .winclip-search, #winclip .winclip-search:focus, #winclip .winclip-search:hover { box-shadow: none; }
#winclip .winclip-search:focus { border-color: ${a(accent, 0.9)}; }
#winclip .winclip-search StLabel.hint-text, #winclip .winclip-search-icon, #winclip .winclip-empty-sub { color: ${a(fg, 0.5)}; }
#winclip .winclip-empty-icon { color: ${a(fg, 0.25)}; }
#winclip .winclip-scroll StScrollBar StButton#vhandle { background-color: ${a(fg, 0.18)}; }
#winclip .winclip-scroll StScrollBar StButton#vhandle:hover { background-color: ${a(fg, 0.35)}; }
`;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (css === this._css && theme === this._theme)
            return;
        if (this._cssFile) {
            this._theme?.unload_stylesheet(this._cssFile);
            this._cssFile.delete(null);
        }
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'winclip']);
        GLib.mkdir_with_parents(dir, 0o700);
        this._cssFile = Gio.File.new_for_path(GLib.build_filenamev([dir, `theme-${GLib.uuid_string_random()}.css`]));
        this._cssFile.replace_contents(new TextEncoder().encode(css), null, false, Gio.FileCreateFlags.PRIVATE, null);
        theme.load_stylesheet(this._cssFile);
        this._css = css;
        this._theme = theme;
    }

    // ---- popup ----

    _toggle() {
        if (this._backdrop)
            this._close();
        else
            this._open();
    }

    _open() {
        this._target = global.display.focus_window;
        try {
            this._applyTheme();
        } catch (e) {
            console.warn(`winclip: colors: ${e.message}`); // stylesheet.css defaults still apply
        }
        const mon = Main.layoutManager.currentMonitor;

        // full-screen invisible layer: clicking outside the card closes it
        // covers every monitor, not just the current one
        this._backdrop = new St.Widget({reactive: true, x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        this._backdrop.connect('button-press-event', (_a, ev) => {
            if (!this._card.contains(global.stage.get_event_actor(ev)))
                this._close();
            return Clutter.EVENT_PROPAGATE;
        });
        // captured (before the focused widget) so our keys work whether a row or the search box has focus
        this._backdrop.connect('captured-event', (_a, ev) =>
            ev.type() === Clutter.EventType.KEY_PRESS ? this._onKey(ev) : Clutter.EVENT_PROPAGATE);

        this._card = new St.BoxLayout({...VERTICAL, style_class: 'winclip', name: 'winclip'});
        const header = new St.BoxLayout({style_class: 'winclip-header'});
        header.add_child(new St.Label({
            text: 'Clipboard', style_class: 'winclip-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));
        const clear = new St.Button({label: 'Clear all', style_class: 'winclip-clear', can_focus: true});
        clear.connect('clicked', () => {
            this._items = this._items.filter(i => i.pinned); // Windows keeps pins on clear
            this._render();
        });
        header.add_child(clear);
        this._card.add_child(header);

        this._search = new St.Entry({
            style_class: 'winclip-search', hint_text: 'Search', can_focus: true, x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'winclip-search-icon'}),
        });
        this._search.clutter_text.connect('text-changed', () => this._render());
        this._card.add_child(this._search);

        this._list = new St.BoxLayout({...VERTICAL});
        this._scroll = new St.ScrollView({
            style_class: 'winclip-scroll', child: this._list, overlay_scrollbars: false,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._card.add_child(this._scroll);

        this._backdrop.add_child(this._card);
        Main.layoutManager.uiGroup.add_child(this._backdrop);
        this._render();

        // open near the pointer (Windows opens near the caret; Wayland doesn't expose it)
        const [px, py] = global.get_pointer();
        const [, w] = this._card.get_preferred_width(-1);
        const [, h] = this._card.get_preferred_height(w);
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
        this._card.set_position(
            clamp(px - w / 2, mon.x + 12, mon.x + mon.width - w - 12),
            clamp(py + 12, mon.y + 12, mon.y + mon.height - h - 12));

        // POPUP mode keeps our own Super+V working, so it closes the popup again
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if (!(this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD)) {
            this._close();
            return;
        }
        (this._rows[0] ?? this._search).grab_key_focus();

        this._card.set_pivot_point(0.5, 0);
        this._card.opacity = 0;
        this._card.scale_x = this._card.scale_y = 0.96;
        this._card.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _close() {
        if (!this._backdrop)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._backdrop.destroy();
        this._backdrop = this._card = this._scroll = this._list = this._grab = this._rows = this._search = this._shown = null;
    }

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        const mods = ev.get_state();
        const focus = global.stage.key_focus;
        const inSearch = focus === this._search.clutter_text;
        const idx = this._rows.indexOf(focus);
        if (sym === Clutter.KEY_Escape) {
            this._close();
        } else if ((mods & Clutter.ModifierType.MOD1_MASK) && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
            const item = this._shown[sym - Clutter.KEY_1]; // Alt+N pastes the Nth item in the list
            if (item)
                this._paste(item);
        } else if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Up) {
            const down = sym === Clutter.KEY_Down;
            const next = inSearch
                ? (down ? this._rows[0] : null)
                : (idx === 0 && !down ? this._search : this._rows[Math.max(0, Math.min(idx + (down ? 1 : -1), this._rows.length - 1))]);
            next?.grab_key_focus();
            if (next && next !== this._search)
                ensureActorVisibleInScrollView(this._scroll, next.get_parent());
        } else if (inSearch && (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter)) {
            if (this._shown[0])
                this._paste(this._shown[0]); // Enter in the search box pastes the best match
        } else if (sym === Clutter.KEY_Delete && idx >= 0) {
            this._remove(this._shown[idx]);
            this._rows[Math.min(idx, this._rows.length - 1)]?.grab_key_focus();
        } else if (!inSearch && !(mods & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
                Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK)) && ev.get_key_unicode() > ' ') {
            // typing while a row is selected starts a search
            this._search.grab_key_focus();
            this._search.clutter_text.insert_unichar(ev.get_key_unicode());
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _remove(item) {
        this._items = this._items.filter(i => i !== item);
        if (item.pinned)
            this._save();
        this._render();
    }

    _render() {
        if (!this._list)
            return;
        this._list.destroy_all_children();
        this._rows = [];
        const q = this._search?.text.trim().toLowerCase() ?? '';
        // ponytail: plain substring match on the first 100k characters of each item
        this._shown = q
            ? this._items.filter(i => (i.lc ??= (i.text ?? i.path ?? '').slice(0, 100000).toLowerCase()).includes(q))
            : this._items;

        if (q && !this._shown.length) {
            this._list.add_child(new St.Label({text: 'No matches', style_class: 'winclip-empty-sub winclip-nomatch', x_expand: true}));
            return;
        }
        if (!this._items.length) {
            const empty = new St.BoxLayout({...VERTICAL, style_class: 'winclip-empty', x_expand: true});
            empty.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'winclip-empty-icon'}));
            empty.add_child(new St.Label({text: 'Nothing here yet', style_class: 'winclip-empty-title'}));
            empty.add_child(new St.Label({text: 'Copy something and it will show up here.', style_class: 'winclip-empty-sub'}));
            this._list.add_child(empty);
            return;
        }

        for (const item of this._shown) {
            const row = new St.BoxLayout({style_class: 'winclip-item', track_hover: true, reactive: true});

            const pick = new St.Button({style_class: 'winclip-pick', can_focus: true, x_expand: true});
            if (item.text !== undefined) {
                const label = new St.Label({text: preview(item.text), style_class: 'winclip-text', x_expand: true, x_align: Clutter.ActorAlign.START});
                label.clutter_text.set_line_wrap(true);
                pick.set_child(label);
            } else {
                // the preview may still be decoding: it's swapped into this slot when ready
                const slot = new St.Bin({x_expand: true, child: this._thumbActor(item)});
                item.slot = slot;
                slot.connect('destroy', () => {
                    if (item.slot === slot)
                        item.slot = null;
                });
                pick.set_child(slot);
            }
            pick.connect('clicked', () => this._paste(item));
            row.add_child(pick);

            const actions = new St.BoxLayout({...VERTICAL, style_class: 'winclip-actions'});
            const pin = new St.Button({
                style_class: `winclip-act${item.pinned ? ' pinned' : ''}`,
                child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 14}),
            });
            pin.connect('clicked', () => {
                item.pinned = !item.pinned;
                this._save();
                this._render();
            });
            const del = new St.Button({
                style_class: 'winclip-act', child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            });
            del.connect('clicked', () => this._remove(item));
            actions.add_child(pin);
            actions.add_child(del);
            row.add_child(actions);

            this._list.add_child(row);
            this._rows.push(pick);
        }
    }

    // ---- pasting ----

    _paste(item) {
        if (item.uris)
            // instant fallback in the Files-app format, in case the helper can't start
            this._clip.set_content(CB, 'x-special/gnome-copied-files',
                new GLib.Bytes(new TextEncoder().encode(['copy', ...item.uris].join('\n'))));
        else if (item.text !== undefined)
            this._clip.set_text(CB, item.text);
        else
            this._clip.set_content(CB, item.mime ?? PNG, item.png);
        const target = this._target;
        this._close();
        if (item.uris)
            this._offerFiles(item, () => this._sendPaste(target));
        else
            this._sendPaste(target);
    }

    // GNOME 46 lets an extension offer only one clipboard format, but Slack, browsers etc. want
    // files as text/uri-list (or the picture). A tiny helper offers all of them, like the Files app.
    _offerFiles(item, done) {
        try {
            const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'winclip']);
            GLib.mkdir_with_parents(dir, 0o700);
            this._helper?.force_exit(); // only one helper alive at a time
            // drop leftovers from a helper that died before reading its files
            const old = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
            for (let info; (info = old.next_file(null));) {
                if (/^\d+-\d+$/.test(info.get_name())) // only helper handover files; previews and colors live here too
                    GLib.unlink(GLib.build_filenamev([dir, info.get_name()]));
            }
            const args = ['python3', '-I', GLib.build_filenamev([this.path, 'paste-helper.py'])];
            const put = (mime, data) => {
                const f = GLib.build_filenamev([dir, `${GLib.get_monotonic_time()}-${args.length}`]);
                GLib.file_set_contents(f, data);
                args.push(`${mime}=${f}`);
            };
            const enc = t => new TextEncoder().encode(t);
            put('x-special/gnome-copied-files', enc(['copy', ...item.uris].join('\n')));
            put('text/uri-list', enc(`${item.uris.join('\r\n')}\r\n`));
            put('text/plain;charset=utf-8', enc(item.uris.map(u => Gio.File.new_for_uri(u).get_path() ?? u).join('\n')));
            if (item.png)
                put(item.mime ?? PNG, item.png.toArray());
            this._helper = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE);
            // paste once it says "ready"; if it dies or takes over 1 s, paste the fallback anyway
            let fired = false;
            const once = () => {
                if (fired)
                    return;
                fired = true;
                this._cancelLater(timer);
                done();
            };
            const timer = this._later(1000, once);
            new Gio.DataInputStream({base_stream: this._helper.get_stdout_pipe()})
                .read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, once);
        } catch (e) {
            console.warn(`winclip: paste helper failed: ${e.message}`);
            done();
        }
    }

    _sendPaste(target) {
        if (!this._vk)
            return; // disabled meanwhile
        // let focus return to the window before typing the shortcut into it
        this._later(120, () => {
            if (!this._vk || global.display.focus_window !== target)
                return; // focus moved elsewhere: the item is on the clipboard, don't type into the wrong window
            const now = () => GLib.get_monotonic_time();
            const keys = [Clutter.KEY_Control_L];
            if (TERMINALS.test(target?.get_wm_class() ?? ''))
                keys.push(Clutter.KEY_Shift_L);
            keys.push(Clutter.KEY_v);
            keys.forEach(k => this._vk.notify_keyval(now(), k, Clutter.KeyState.PRESSED));
            keys.reverse().forEach(k => this._vk.notify_keyval(now(), k, Clutter.KeyState.RELEASED));
        });
    }
}
