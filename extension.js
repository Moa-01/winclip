import GLib from 'gi://GLib';
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

const MAX = 25; // same caps as Windows: 25 items, 4 MB per item
const MAX_BYTES = 4 * 1024 * 1024;
const PNG = 'image/png';
const CB = St.ClipboardType.CLIPBOARD;
const STORE_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'winclip']);
const STORE = GLib.build_filenamev([STORE_DIR, 'pinned.json']);
// terminals paste with Ctrl+Shift+V
const TERMINALS = /term|kitty|alacritty|wezterm|foot|konsole|tilix|ghostty|terminator|ptyxis|herdr/i;

// GNOME disables extensions on screen lock; keep history across that like Windows does
let kept = null;

function keyOf(item) {
    return item.text !== undefined
        ? `t:${item.text}`
        : `i:${GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, item.png)}`;
}

function preview(text) {
    const t = text.replace(/^\s+/, '').split('\n').slice(0, 4).join('\n');
    return t.length > 280 ? `${t.slice(0, 280)}…` : t;
}

export default class WinClip extends Extension {
    enable() {
        this._clip = St.Clipboard.get_default();
        this._items = kept ?? this._load();
        this._vk = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._sel = global.display.get_selection();
        this._selId = this._sel.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onCopy();
        });
        Main.wm.addKeybinding('toggle-history', this.getSettings(), Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-history');
        this._sel.disconnect(this._selId);
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        if (this._readyId)
            GLib.source_remove(this._readyId);
        this._close();
        kept = this._items;
        this._clip = this._items = this._vk = this._sel = this._pasteId = this._readyId = null;
    }

    // ---- history ----

    _onCopy() {
        const types = this._clip.get_mimetypes(CB);
        if (types.includes('x-kde-passwordManagerHint'))
            return; // password managers flag secrets; never record them, like Windows
        const img = types.includes(PNG) ? PNG : types.find(t => t.startsWith('image/'));
        if (img && !types.some(t => t.startsWith('text/plain') || t === 'UTF8_STRING'))
            // copy now: St frees these bytes once the callback returns
            this._clip.get_content(CB, img, (_c, b) => b?.get_size() && b.get_size() <= MAX_BYTES && this._add({png: new GLib.Bytes(b.toArray()), mime: img}));
        else if (types.includes('text/uri-list'))
            this._clip.get_content(CB, 'text/uri-list', (_c, b) => this._addFile(b));
        else
            this._clip.get_text(CB, (_c, text) => text?.trim() && text.length <= MAX_BYTES && this._add({text}));
    }

    // Files copied in the Files app: one image shows as the picture, anything else as its path.
    // Either way it keeps the file list, so pasting gives the files back (Files app, desktop).
    _addFile(bytes) {
        const uris = new TextDecoder().decode(bytes?.toArray() ?? []).split(/\r?\n/).filter(u => u && !u.startsWith('#'));
        const ext = uris[0]?.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i)?.[1].toLowerCase();
        if (uris.length === 1 && ext) {
            try {
                const file = Gio.File.new_for_uri(uris[0]);
                if (file.query_info('standard::size', 0, null).get_size() > MAX_BYTES)
                    throw new Error('too big');
                const [, data] = file.load_contents(null);
                const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext.replace('jpg', 'jpeg')}`;
                this._add({png: new GLib.Bytes(data), mime, path: file.get_path(), uris});
                return;
            } catch {}
        }
        const text = uris.map(u => decodeURIComponent(u.replace(/^file:\/\//, ''))).join('\n');
        if (text)
            this._add({text, uris});
    }

    _add(item) {
        if (!this._items)
            return; // callback landed after disable
        // A file copy offers both the file and its path as text; keep only the picture.
        const asPath = t => t?.trim().startsWith('file://') ? Gio.File.new_for_uri(t.trim()).get_path() : t?.trim();
        if (item.text !== undefined && this._items.some(i => i.path && i.path === asPath(item.text)))
            return;
        if (item.path)
            this._items = this._items.filter(i => i.text === undefined || asPath(i.text) !== item.path);
        item.key = keyOf(item);
        const dup = this._items.findIndex(i => i.key === item.key);
        if (dup >= 0)
            item.pinned = this._items.splice(dup, 1)[0].pinned;
        this._items.unshift(item);
        while (this._items.length > MAX) {
            const old = this._items.findLastIndex(i => !i.pinned);
            if (old < 0)
                break;
            this._items.splice(old, 1);
        }
        this._render();
    }

    // Like Windows: unpinned history dies with the session, pinned items survive.
    // ponytail: images inlined as base64 in one JSON file; fine for a handful of pins.
    _save() {
        const pinned = this._items.filter(i => i.pinned).map(i => i.text !== undefined
            ? {text: i.text, uris: i.uris}
            : {png: GLib.base64_encode(i.png.toArray()), mime: i.mime, uris: i.uris, path: i.path});
        GLib.mkdir_with_parents(STORE_DIR, 0o700);
        GLib.file_set_contents(STORE, JSON.stringify(pinned));
    }

    _load() {
        try {
            const [, data] = GLib.file_get_contents(STORE);
            return JSON.parse(new TextDecoder().decode(data)).map(i => {
                const item = i.text !== undefined
                    ? {text: i.text, uris: i.uris}
                    : {png: new GLib.Bytes(GLib.base64_decode(i.png)), mime: i.mime, uris: i.uris, path: i.path};
                return {...item, key: keyOf(item), pinned: true};
            });
        } catch {
            return [];
        }
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
        const mon = Main.layoutManager.currentMonitor;

        // full-screen invisible layer: clicking outside the card closes it
        // covers every monitor, not just the current one
        this._backdrop = new St.Widget({reactive: true, x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        this._backdrop.connect('button-press-event', (_a, ev) => {
            if (!this._card.contains(global.stage.get_event_actor(ev)))
                this._close();
            return Clutter.EVENT_PROPAGATE;
        });
        this._backdrop.connect('key-press-event', (_a, ev) => this._onKey(ev.get_key_symbol()));

        this._card = new St.BoxLayout({vertical: true, style_class: 'winclip'});
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

        this._list = new St.BoxLayout({vertical: true});
        this._scroll = new St.ScrollView({
            style_class: 'winclip-scroll', child: this._list, overlay_scrollbars: true,
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

        this._grab = Main.pushModal(this._backdrop);
        if (!(this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD)) {
            this._close();
            return;
        }
        this._rows[0]?.grab_key_focus();

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
        this._backdrop = this._card = this._scroll = this._list = this._grab = this._rows = null;
    }

    _onKey(sym) {
        const focus = global.stage.key_focus;
        const idx = this._rows.findIndex(r => r === focus);
        if (sym === Clutter.KEY_Escape) {
            this._close();
        } else if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Up) {
            const next = this._rows[Math.max(0, Math.min(idx + (sym === Clutter.KEY_Down ? 1 : -1), this._rows.length - 1))];
            next?.grab_key_focus();
            if (next)
                ensureActorVisibleInScrollView(this._scroll, next.get_parent());
        } else if (sym === Clutter.KEY_Delete && idx >= 0) {
            this._remove(this._items[idx]);
            this._rows[Math.min(idx, this._rows.length - 1)]?.grab_key_focus();
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

        if (!this._items.length) {
            const empty = new St.BoxLayout({vertical: true, style_class: 'winclip-empty', x_expand: true});
            empty.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'winclip-empty-icon'}));
            empty.add_child(new St.Label({text: 'Nothing here yet', style_class: 'winclip-empty-title'}));
            empty.add_child(new St.Label({text: 'Copy something and it will show up here.', style_class: 'winclip-empty-sub'}));
            this._list.add_child(empty);
            return;
        }

        for (const item of this._items) {
            const row = new St.BoxLayout({style_class: 'winclip-item', track_hover: true, reactive: true});

            const pick = new St.Button({style_class: 'winclip-pick', can_focus: true, x_expand: true});
            pick.set_child(item.text !== undefined
                ? new St.Label({text: preview(item.text), style_class: 'winclip-text', x_expand: true, x_align: Clutter.ActorAlign.START})
                : this._thumb(item));
            pick.child.clutter_text?.set_line_wrap(true);
            pick.connect('clicked', () => this._paste(item));
            row.add_child(pick);

            const actions = new St.BoxLayout({vertical: true, style_class: 'winclip-actions'});
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

    // Small decoded thumbnail, made once per item and reused; full image is never decoded.
    _thumb(item) {
        if (item.thumb === undefined) {
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_stream_at_scale(
                    Gio.MemoryInputStream.new_from_bytes(item.png), 300, 170, true, null);
                item.thumb = St.ImageContent.new_with_preferred_size(pb.width, pb.height);
                item.thumb.set_bytes(pb.read_pixel_bytes(),
                    pb.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                    pb.width, pb.height, pb.rowstride);
            } catch (e) {
                console.warn(`winclip: no thumbnail: ${e.message}`);
                item.thumb = null;
            }
        }
        if (!item.thumb)
            return new St.Label({text: 'Image', style_class: 'winclip-text', x_expand: true});
        const [, w, h] = item.thumb.get_preferred_size();
        return new St.Widget({content: item.thumb, width: w, height: h, x_align: Clutter.ActorAlign.START});
    }

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
            for (let info; (info = old.next_file(null));)
                GLib.unlink(GLib.build_filenamev([dir, info.get_name()]));
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
                if (this._readyId)
                    GLib.source_remove(this._readyId);
                this._readyId = null;
                done();
            };
            this._readyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._readyId = null;
                once();
                return GLib.SOURCE_REMOVE;
            });
            new Gio.DataInputStream({base_stream: this._helper.get_stdout_pipe()})
                .read_line_async(GLib.PRIORITY_DEFAULT, null, once);
        } catch (e) {
            console.warn(`winclip: paste helper failed: ${e.message}`);
            done();
        }
    }

    _sendPaste(target) {
        if (!this._vk)
            return; // disabled meanwhile
        // let focus return to the window before typing the shortcut into it
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._pasteId = null;
            const now = () => GLib.get_monotonic_time();
            const keys = [Clutter.KEY_Control_L];
            if (TERMINALS.test(target?.get_wm_class() ?? ''))
                keys.push(Clutter.KEY_Shift_L);
            keys.push(Clutter.KEY_v);
            keys.forEach(k => this._vk.notify_keyval(now(), k, Clutter.KeyState.PRESSED));
            keys.reverse().forEach(k => this._vk.notify_keyval(now(), k, Clutter.KeyState.RELEASED));
            return GLib.SOURCE_REMOVE;
        });
    }
}
