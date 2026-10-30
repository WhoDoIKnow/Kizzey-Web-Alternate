#!/usr/bin/env python3
"""Gateway transport checks: zlib-stream frames and the frame size guard."""

import json
import os
import struct
import sys
import threading
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

CHECKS = []


def check(ok, label, detail=""):
    CHECKS.append(bool(ok))
    print(("ok: " if ok else "FAIL: ") + label + ("" if ok else f" [{detail}]"))


class FakeSock:
    def __init__(self, data):
        self.data = bytearray(data)

    def recv(self, count):
        if not self.data:
            return b""
        out = bytes(self.data[:count])
        del self.data[:count]
        return out


def frame(payload, opcode=2, fin=True):
    first = (0x80 if fin else 0) | opcode
    size = len(payload)
    if size < 126:
        return bytes([first, size]) + payload
    if size < 65536:
        return bytes([first, 126]) + struct.pack("!H", size) + payload
    return bytes([first, 127]) + struct.pack("!Q", size) + payload


def make_ws(data):
    ws = object.__new__(server.WSClient)
    ws.sock = FakeSock(data)
    ws.buf = b""
    ws.compressed = bytearray()
    ws.compressed_mode = False
    ws.inflator = zlib.decompressobj()
    ws.send_lock = threading.Lock()
    return ws


def compressed(payload):
    return zlib.compress(payload) + b"\x00\x00\xff\xff"


hello = json.dumps({"op": 10, "d": {"heartbeat_interval": 41250}}).encode()
ws = make_ws(frame(compressed(hello)))
check(json.loads(ws.recv())["op"] == 10, "a zlib-stream event is decompressed")

ws = make_ws(frame(compressed(hello)[:5], fin=False) + frame(compressed(hello)[5:], opcode=0))
check(json.loads(ws.recv())["op"] == 10, "a split compressed event is reassembled")

ws = make_ws(frame(hello, opcode=1))
check(json.loads(ws.recv())["op"] == 10, "uncompressed text frames still work")

ws = make_ws(bytes([0x82, 127]) + struct.pack("!Q", 64 * 1024 * 1024 + 1))
try:
    ws.recv()
    check(False, "oversized gateway frames are refused")
except server.GatewayClosed as exc:
    check("too large" in str(exc), "oversized gateway frames are refused", str(exc))

passed = sum(1 for item in CHECKS if item)
print(f"{passed}/{len(CHECKS)} gateway checks passed")
sys.exit(0 if passed == len(CHECKS) else 1)
