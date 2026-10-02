#!/usr/bin/env python3
"""DejaML dependency-preparation egress proxy (trust zone 2).

A deliberately small HTTP CONNECT proxy built only on the Python standard
library. It is the single route from the internal preparation network to the
outside world and it allows exactly one thing: a CONNECT tunnel to port 443 of
a host that is in the allowlist given on the command line (exact match).

Everything else is answered with 403 and logged: plain HTTP requests, other
methods, other ports, IP literals, unknown hosts, and hosts whose DNS answers
include any non-global address (loopback, private, link-local, cloud metadata,
...). The proxy resolves the host itself and connects to one of the validated
addresses, so a second DNS answer cannot redirect the tunnel (no rebinding).

It enforces a total byte budget across all tunnels and a per-tunnel idle
timeout. One JSON line per connection is printed to stdout.
"""

import argparse
import asyncio
import ipaddress
import json
import re
import socket
import sys
import time

HOST_RE = re.compile(
    r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
MAX_HEAD_BYTES = 8192
HEAD_TIMEOUT_S = 10
CONNECT_TIMEOUT_S = 15
MAX_CONNECTIONS = 64
CHUNK = 65536

FORBIDDEN = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
BAD_GATEWAY = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
ESTABLISHED = b"HTTP/1.1 200 Connection Established\r\n\r\n"


def log(event):
    sys.stdout.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


def is_ip_literal(host):
    candidate = host.strip("[]")
    try:
        ipaddress.ip_address(candidate)
        return True
    except ValueError:
        pass
    # glibc also accepts shorthand numeric forms such as "127.1" or "0x7f.1".
    parts = candidate.split(".")
    return all(re.fullmatch(r"0x[0-9a-f]*|[0-9]+", part) for part in parts)


class Proxy:
    def __init__(self, allowed, budget_bytes, idle_timeout):
        self.allowed = frozenset(allowed)
        self.budget = budget_bytes
        self.idle_timeout = idle_timeout
        self.used = 0
        self.exceeded = False
        self.active = set()
        self.slots = asyncio.Semaphore(MAX_CONNECTIONS)

    def charge(self, count):
        """Charge bytes against the global budget; False once it is exhausted."""
        if self.exceeded:
            return False
        self.used += count
        if self.used > self.budget:
            self.exceeded = True
            log({"event": "budget_exceeded", "used": self.used, "budget": self.budget})
            for writer in list(self.active):
                writer.close()
            return False
        return True

    async def handle(self, reader, writer):
        started = time.monotonic()
        entry = {
            "event": "connect",
            "host": None,
            "ip": None,
            "allowed": False,
            "reason": "unknown",
            "bytes_up": 0,
            "bytes_down": 0,
            "ms": 0,
        }
        upstream_writer = None
        self.active.add(writer)
        try:
            if self.slots.locked():
                entry["reason"] = "too_many_connections"
                writer.write(FORBIDDEN)
                return
            async with self.slots:
                upstream_writer = await self.serve(reader, writer, entry)
        except Exception as error:  # never let one tunnel take the proxy down
            if entry["reason"] in ("unknown", "ok"):
                entry["reason"] = "error:" + type(error).__name__
        finally:
            self.active.discard(writer)
            for stream in (writer, upstream_writer):
                if stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass
            entry["ms"] = int((time.monotonic() - started) * 1000)
            log(entry)

    async def serve(self, reader, writer, entry):
        def deny(reason):
            entry["allowed"] = False
            entry["reason"] = reason
            writer.write(FORBIDDEN)
            return None

        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_TIMEOUT_S)
        except (asyncio.LimitOverrunError, asyncio.IncompleteReadError, asyncio.TimeoutError, ValueError):
            return deny("malformed_request")
        try:
            request_line = head.split(b"\r\n", 1)[0].decode("ascii")
        except UnicodeDecodeError:
            return deny("malformed_request")
        parts = request_line.split(" ")
        if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
            return deny("malformed_request")
        method, target, _version = parts
        if method != "CONNECT":
            entry["host"] = target[:200]
            return deny("method_not_allowed")
        host, sep, port = target.rpartition(":")
        host = host.lower()
        entry["host"] = host[:253] or None
        if not sep or not host:
            return deny("malformed_target")
        if port != "443":
            return deny("port_not_allowed")
        if host.startswith("[") or is_ip_literal(host):
            return deny("ip_literal")
        if host not in self.allowed or not HOST_RE.match(host):
            return deny("host_not_allowed")
        if self.exceeded:
            return deny("budget_exceeded")

        loop = asyncio.get_running_loop()
        try:
            infos = await asyncio.wait_for(
                loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP),
                CONNECT_TIMEOUT_S,
            )
        except (OSError, asyncio.TimeoutError):
            return deny("dns_failure")
        addresses = []
        for family, _type, _proto, _canon, sockaddr in infos:
            address = sockaddr[0].split("%", 1)[0]
            try:
                parsed = ipaddress.ip_address(address)
            except ValueError:
                return deny("dns_invalid_answer")
            # Reject the whole host if ANY answer is non-global.
            if not parsed.is_global:
                entry["ip"] = address
                return deny("non_global_address")
            addresses.append((family, address))
        if not addresses:
            return deny("dns_failure")
        # Connect to exactly one validated address (IPv4 first, the order most
        # container networks can actually route); it is never re-resolved.
        addresses.sort(key=lambda item: 0 if item[0] == socket.AF_INET else 1)
        entry["ip"] = addresses[0][1]
        entry["allowed"] = True
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_connection(entry["ip"], 443), CONNECT_TIMEOUT_S
            )
        except (OSError, asyncio.TimeoutError):
            entry["reason"] = "upstream_connect_failed"
            writer.write(BAD_GATEWAY)
            return None
        entry["reason"] = "ok"
        self.active.add(upstream_writer)
        try:
            writer.write(ESTABLISHED)
            await writer.drain()
            await self.pipe(reader, writer, upstream_reader, upstream_writer, entry)
        finally:
            self.active.discard(upstream_writer)
        return upstream_writer

    async def pipe(self, client_reader, client_writer, upstream_reader, upstream_writer, entry):
        last = [time.monotonic()]

        async def pump(source, sink, key):
            while True:
                data = await source.read(CHUNK)
                if not data:
                    break
                last[0] = time.monotonic()
                if not self.charge(len(data)):
                    entry["reason"] = "budget_exceeded"
                    break
                entry[key] += len(data)
                sink.write(data)
                await sink.drain()
            try:
                if sink.can_write_eof():
                    sink.write_eof()
            except OSError:
                pass

        async def watchdog():
            while True:
                await asyncio.sleep(1)
                if time.monotonic() - last[0] > self.idle_timeout:
                    entry["reason"] = "idle_timeout"
                    return

        up = asyncio.ensure_future(pump(client_reader, upstream_writer, "bytes_up"))
        down = asyncio.ensure_future(pump(upstream_reader, client_writer, "bytes_down"))
        guard = asyncio.ensure_future(watchdog())
        pending = {up, down, guard}
        try:
            while up in pending or down in pending:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                if guard in done or entry["reason"] == "budget_exceeded":
                    break
                for task in done:
                    if task.exception() is not None:
                        pending.discard(guard)
                        raise task.exception()
        finally:
            for task in (up, down, guard):
                task.cancel()
            await asyncio.gather(up, down, guard, return_exceptions=True)


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", default="0.0.0.0:3128")
    parser.add_argument("--allow", action="append", default=[], help="allowed host (exact match); repeatable")
    parser.add_argument("--budget-bytes", type=int, required=True)
    parser.add_argument("--idle-timeout", type=int, default=60)
    args = parser.parse_args(argv)
    allowed = []
    for host in args.allow:
        host = host.strip().lower()
        if not HOST_RE.match(host) or is_ip_literal(host):
            parser.error("invalid allowed host: %r" % host)
        allowed.append(host)
    if not allowed:
        parser.error("at least one --allow host is required")
    if args.budget_bytes <= 0 or args.idle_timeout <= 0:
        parser.error("budget and idle timeout must be positive")
    args.allow = allowed
    return args


async def main(argv):
    args = parse_args(argv)
    bind_host, _, bind_port = args.listen.rpartition(":")
    proxy = Proxy(args.allow, args.budget_bytes, args.idle_timeout)
    server = await asyncio.start_server(proxy.handle, bind_host, int(bind_port), limit=MAX_HEAD_BYTES)
    log({"event": "listening", "listen": args.listen, "allow": sorted(proxy.allowed), "budget": args.budget_bytes})
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main(sys.argv[1:]))
    except KeyboardInterrupt:
        pass
