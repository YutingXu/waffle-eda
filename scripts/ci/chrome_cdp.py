"""Stdlib Chrome DevTools WebSocket transport.

Callers own Chrome, the socket timeout, request ids, reply and error policy,
and trace marks. This module upgrades the socket, frames text, and returns
raw messages and events.
"""
import base64
import json
import os
import socket
import struct


def _raise(factory):
    if factory is None:
        raise EOFError("DevTools connection closed")
    if isinstance(factory, BaseException):
        raise factory
    raise factory()


class Wire:
    def __init__(self, sock, buf=b"", eof=None):
        self.sock = sock
        self.buf = buf
        self.eof = eof

    def recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                _raise(self.eof)
            self.buf += chunk
        data, self.buf = self.buf[:n], self.buf[n:]
        return data

    def read_message(self):
        message = b""
        while True:
            b0, b1 = self.recv(2)
            size = b1 & 127
            if size == 126:
                size = struct.unpack(">H", self.recv(2))[0]
            elif size == 127:
                size = struct.unpack(">Q", self.recv(8))[0]
            message += self.recv(size)
            if b0 & 0x80:  # final fragment
                break
        return json.loads(message)

    def send_text(self, text):
        data = text.encode()
        size = len(data)
        header = bytearray([0x81])
        if size < 126:
            header.append(0x80 | size)
        elif size < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", size)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", size)
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        self.sock.sendall(bytes(header) + mask + masked)

    def raw_reply(self, method, params, message_id, on_event=None):
        self.send_text(json.dumps({"id": message_id, "method": method, "params": params}))
        while True:
            message = self.read_message()
            if on_event:
                on_event(message)
            if message.get("id") == message_id:
                return message


def checked_result(method, reply):
    """Page.call adapter used by perf-route and the worker harness."""
    if "error" in reply:
        raise RuntimeError(method + ": " + json.dumps(reply["error"]))
    return reply.get("result", {})


def connect(ws_url, timeout=None, eof=None, refused=None):
    """Upgrade a DevTools WebSocket. `timeout` is stored on the socket for the caller."""
    host, path = ws_url.split("://", 1)[1].split("/", 1)
    name, port = host.split(":")
    sock = socket.create_connection((name, int(port)), timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((
        "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
        % (path, host, key)
    ).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            _raise(refused if refused is not None else eof)
        buf += chunk
    return Wire(sock, buf.split(b"\r\n\r\n", 1)[1], eof)
