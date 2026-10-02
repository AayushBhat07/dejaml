"""Drives egress_proxy.py in-process with a fake resolver (no network)."""
import asyncio, importlib.util, io, json, socket, sys, contextlib

spec = importlib.util.spec_from_file_location("egress_proxy", sys.argv[1])
proxy_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy_module)

FAKE_DNS = {
    "pypi.org": ["151.101.0.223"],
    "evil.pypi-mirror.test": ["151.101.0.223"],
    "files.pythonhosted.org": ["151.101.1.63", "10.0.0.5"],  # one private answer poisons the host
    "metadata.example": ["169.254.169.254"],
}


async def fake_getaddrinfo(host, port, **kwargs):
    if host not in FAKE_DNS:
        raise socket.gaierror("no such host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in FAKE_DNS[host]]


async def fake_open_connection(host, port):
    raise OSError("upstream disabled in tests")


REAL_OPEN_CONNECTION = asyncio.open_connection


async def request(port, raw):
    reader, writer = await REAL_OPEN_CONNECTION("127.0.0.1", port)
    writer.write(raw)
    await writer.drain()
    data = await asyncio.wait_for(reader.read(200), 5)
    writer.close()
    return data.split(b"\r\n", 1)[0].decode()


async def main():
    loop = asyncio.get_running_loop()
    loop.getaddrinfo = fake_getaddrinfo
    proxy_module.asyncio.open_connection = fake_open_connection
    proxy = proxy_module.Proxy(["pypi.org", "files.pythonhosted.org", "metadata.example"], 1000, 5)
    server = await asyncio.start_server(proxy.handle, "127.0.0.1", 0, limit=8192)
    port = server.sockets[0].getsockname()[1]
    cases = {
        "plain_get": b"GET http://pypi.org/ HTTP/1.1\r\nHost: pypi.org\r\n\r\n",
        "other_port": b"CONNECT pypi.org:80 HTTP/1.1\r\n\r\n",
        "ip_literal": b"CONNECT 1.1.1.1:443 HTTP/1.1\r\n\r\n",
        "ipv6_literal": b"CONNECT [::1]:443 HTTP/1.1\r\n\r\n",
        "shorthand_ip": b"CONNECT 127.1:443 HTTP/1.1\r\n\r\n",
        "unknown_host": b"CONNECT evil.pypi-mirror.test:443 HTTP/1.1\r\n\r\n",
        "private_answer": b"CONNECT files.pythonhosted.org:443 HTTP/1.1\r\n\r\n",
        "metadata_answer": b"CONNECT metadata.example:443 HTTP/1.1\r\n\r\n",
        "allowed_upstream_down": b"CONNECT pypi.org:443 HTTP/1.1\r\n\r\n",
    }
    responses = {}
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        for name, raw in cases.items():
            responses[name] = await request(port, raw)
        await asyncio.sleep(0.1)
        proxy.charge(2000)
    server.close()
    logs = [json.loads(line) for line in captured.getvalue().splitlines() if line.strip()]
    print(json.dumps({"responses": responses, "logs": logs}))


asyncio.run(main())
