#!/usr/bin/env python3
"""Offers several clipboard formats at once, which a GNOME 46 extension can't do itself.

Usage: paste-helper.py mime=file [mime=file ...]

Reads each file into memory (and deletes it), then owns the CLIPBOARD through X11
(an X11 client may take the clipboard without having focus; GNOME forwards every
format to Wayland apps too). Prints "ready" once it owns it, and exits as soon as
anything else takes the clipboard.

Plain Python + libX11 via ctypes: no extra packages, ~10 MB of memory.
"""
import ctypes as C
import os
import signal
import sys

x = C.CDLL('libX11.so.6')
ulong, cint, vp = C.c_ulong, C.c_int, C.c_void_p

PropertyNotify, SelectionClear, SelectionRequest, SelectionNotify = 28, 29, 30, 31
PropertyChangeMask = 1 << 22
PropModeReplace, PropModeAppend = 0, 2


class SelReq(C.Structure):
    _fields_ = [('type', cint), ('serial', ulong), ('send_event', cint), ('display', vp),
                ('owner', ulong), ('requestor', ulong), ('selection', ulong),
                ('target', ulong), ('property', ulong), ('time', ulong)]


class SelNotify(C.Structure):
    _fields_ = [('type', cint), ('serial', ulong), ('send_event', cint), ('display', vp),
                ('requestor', ulong), ('selection', ulong), ('target', ulong),
                ('property', ulong), ('time', ulong)]


class PropEv(C.Structure):
    _fields_ = [('type', cint), ('serial', ulong), ('send_event', cint), ('display', vp),
                ('window', ulong), ('atom', ulong), ('time', ulong), ('state', cint)]


class XEvent(C.Union):
    _fields_ = [('type', cint), ('req', SelReq), ('notify', SelNotify), ('prop', PropEv),
                ('pad', C.c_long * 24)]


def sig(name, res, *args):
    f = getattr(x, name)
    f.restype, f.argtypes = res, list(args)
    return f


XOpenDisplay = sig('XOpenDisplay', vp, C.c_char_p)
XDefaultRootWindow = sig('XDefaultRootWindow', ulong, vp)
XCreateSimpleWindow = sig('XCreateSimpleWindow', ulong, vp, ulong, cint, cint, C.c_uint, C.c_uint,
                          C.c_uint, ulong, ulong)
XSelectInput = sig('XSelectInput', cint, vp, ulong, C.c_long)
XInternAtom = sig('XInternAtom', ulong, vp, C.c_char_p, cint)
XChangeProperty = sig('XChangeProperty', cint, vp, ulong, ulong, ulong, cint, cint, vp, cint)
XSetSelectionOwner = sig('XSetSelectionOwner', cint, vp, ulong, ulong, ulong)
XGetSelectionOwner = sig('XGetSelectionOwner', ulong, vp, ulong)
XSendEvent = sig('XSendEvent', cint, vp, ulong, cint, C.c_long, C.POINTER(XEvent))
XNextEvent = sig('XNextEvent', cint, vp, C.POINTER(XEvent))
XFlush = sig('XFlush', cint, vp)


def main():
    formats = {}
    for arg in sys.argv[1:]:
        mime, _, path = arg.rpartition('=')  # mime may contain '=' (charset=utf-8), paths don't
        with open(path, 'rb') as f:
            formats[mime] = f.read()
        os.unlink(path)

    signal.alarm(5)  # never linger if X11 is unavailable or stuck starting
    dpy = XOpenDisplay(None)
    if not dpy:
        sys.exit('cannot open X display')
    atom = lambda name: XInternAtom(dpy, name.encode(), 0)
    clipboard, targets, atom_t = atom('CLIPBOARD'), atom('TARGETS'), atom('ATOM')
    by_atom = {atom(m): data for m, data in formats.items()}

    win = XCreateSimpleWindow(dpy, XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0)
    XSelectInput(dpy, win, PropertyChangeMask)

    # Get a real server timestamp (ICCCM): touch a property and read the time from the event.
    ev = XEvent()
    XChangeProperty(dpy, win, targets, atom_t, 32, PropModeAppend, None, 0)
    while XNextEvent(dpy, C.byref(ev)) == 0 and ev.type != PropertyNotify:
        pass
    stamp = ev.prop.time

    XSetSelectionOwner(dpy, clipboard, win, stamp)
    if XGetSelectionOwner(dpy, clipboard) != win:
        sys.exit('could not take the clipboard')
    signal.alarm(0)
    print('ready', flush=True)

    while XNextEvent(dpy, C.byref(ev)) == 0:
        if ev.type == SelectionClear:
            return  # someone else copied something: our job is done
        if ev.type != SelectionRequest:
            continue
        r = ev.req
        prop = r.property or r.target  # obsolete clients pass None
        if r.target == targets:
            atoms = (ulong * (len(by_atom) + 1))(targets, *by_atom)
            XChangeProperty(dpy, r.requestor, prop, atom_t, 32, PropModeReplace, atoms, len(atoms))
        elif r.target in by_atom:
            # ponytail: no INCR transfers; fine for WinClip's 4 MB item cap (Xwayland has BIG-REQUESTS)
            data = by_atom[r.target]
            XChangeProperty(dpy, r.requestor, prop, r.target, 8, PropModeReplace, data, len(data))
        else:
            prop = 0  # refuse unknown formats
        reply = XEvent()
        reply.notify = SelNotify(SelectionNotify, 0, 1, None, r.requestor, r.selection,
                                 r.target, prop, r.time)
        XSendEvent(dpy, r.requestor, 0, 0, C.byref(reply))
        XFlush(dpy)


if __name__ == '__main__':
    main()
