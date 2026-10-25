#!/usr/bin/env python3
"""系统级按键（绕开 CUA 的“用户正在操作”保护）。
用法: human_key.py --key v|return|escape|w|tab|space|delete [--cmd] [--shift]
"""
import argparse, ctypes, random, sys, time

AS = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
AS.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
AS.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
AS.CGEventSetFlags.restype = None
AS.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
AS.CGEventPost.restype = None
AS.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
AS.CFRelease.restype = None
AS.CFRelease.argtypes = [ctypes.c_void_p]

CODES = {'v': 9, 'return': 36, 'escape': 53, 'w': 13, 'tab': 48, 'space': 49, 'delete': 51, 'a': 0, 'enter': 76, 'r': 15, 'f': 3, 'd': 2, 'p': 35}
FLAG_CMD, FLAG_SHIFT = 1 << 20, 1 << 17
HID = 0

def press(code, flags):
    d = AS.CGEventCreateKeyboardEvent(None, code, True)
    u = AS.CGEventCreateKeyboardEvent(None, code, False)
    if flags:
        AS.CGEventSetFlags(d, flags); AS.CGEventSetFlags(u, flags)
    AS.CGEventPost(HID, d)
    time.sleep(random.uniform(.035, .10))
    AS.CGEventPost(HID, u)
    AS.CFRelease(d); AS.CFRelease(u)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--key', default='return')
    ap.add_argument('--keycode', type=int)
    ap.add_argument('--cmd', action='store_true')
    ap.add_argument('--shift', action='store_true')
    a = ap.parse_args()
    code = a.keycode if a.keycode is not None else CODES.get(a.key.lower())
    if code is None:
        print('unknown key', a.key, file=sys.stderr); return 2
    flags = (FLAG_CMD if a.cmd else 0) | (FLAG_SHIFT if a.shift else 0)
    press(code, flags)
    return 0

if __name__ == '__main__':
    sys.exit(main())
