#!/usr/bin/env python3
"""人类化鼠标：沿随机三次贝塞尔曲线移动，可选点击。
用法: human_mouse.py --x 500 --y 300 [--button left|right|none] [--fast]
仅依赖 ctypes + ApplicationServices（需辅助功能权限）。
"""
import argparse, ctypes, random, time, sys

AS = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')

class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]

AS.CGEventCreateMouseEvent.restype = ctypes.c_void_p
AS.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
AS.CGEventPost.restype = None
AS.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
AS.CGEventCreate.restype = ctypes.c_void_p
AS.CGEventCreate.argtypes = [ctypes.c_void_p]
AS.CGEventGetLocation.restype = CGPoint
AS.CGEventGetLocation.argtypes = [ctypes.c_void_p]
AS.CFRelease.restype = None
AS.CFRelease.argtypes = [ctypes.c_void_p]

MOVED, LDOWN, LUP, RDOWN, RUP = 5, 1, 2, 3, 4
HID = 0

def pos():
    e = AS.CGEventCreate(None)
    p = AS.CGEventGetLocation(e)
    AS.CFRelease(e)
    return p.x, p.y

def post(t, x, y):
    e = AS.CGEventCreateMouseEvent(None, t, CGPoint(x, y), 0)
    AS.CGEventPost(HID, e)
    AS.CFRelease(e)

def bez(p0, p1, p2, p3, t):
    u = 1 - t
    x = u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0]
    y = u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]
    return x, y

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--x', type=float, required=True)
    ap.add_argument('--y', type=float, required=True)
    ap.add_argument('--button', default='left', choices=['left', 'right', 'none'])
    ap.add_argument('--fast', action='store_true')
    a = ap.parse_args()

    sx, sy = pos()
    dx, dy = a.x - sx, a.y - sy
    dist = (dx*dx + dy*dy) ** 0.5
    if dist < 1:
        if a.button != 'none':
            t = LDOWN if a.button == 'left' else RDOWN
            u = LUP if a.button == 'left' else RUP
            post(t, a.x, a.y); time.sleep(random.uniform(.05, .13)); post(u, a.x, a.y)
        return 0

    # 垂直于路线的随机偏移，制造弧度
    ux, uy = -dy / dist, dx / dist
    amp = min(160, 25 + dist * random.uniform(.08, .22)) * random.choice([-1, 1])
    j1 = (sx + dx * random.uniform(.20, .35) + ux * amp, sy + dy * random.uniform(.20, .35) + uy * amp)
    amp2 = amp * random.uniform(-.6, .6)
    j2 = (sx + dx * random.uniform(.65, .80) + ux * amp2, sy + dy * random.uniform(.65, .80) + uy * amp2)

    steps = random.randint(18, 34) if a.fast else random.randint(26, 48)
    dur = random.uniform(.22, .38) if a.fast else random.uniform(.35, .65)
    for i in range(1, steps + 1):
        t = i / steps
        te = t * t * (3 - 2 * t)  # ease-in-out
        x, y = bez((sx, sy), j1, j2, (a.x, a.y), te)
        x += random.uniform(-0.7, 0.7); y += random.uniform(-0.7, 0.7)
        post(MOVED, x, y)
        time.sleep(dur / steps * random.uniform(.7, 1.35))
    post(MOVED, a.x, a.y)
    time.sleep(random.uniform(.06, .18))

    if a.button != 'none':
        t = LDOWN if a.button == 'left' else RDOWN
        u = LUP if a.button == 'left' else RUP
        post(t, a.x, a.y)
        time.sleep(random.uniform(.05, .13))
        post(u, a.x, a.y)

    ex, ey = pos()
    if abs(ex - a.x) > 3 or abs(ey - a.y) > 3:
        print('WARN position mismatch', ex, ey, file=sys.stderr)
        return 2
    return 0

if __name__ == '__main__':
    sys.exit(main())
