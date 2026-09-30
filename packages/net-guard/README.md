# DéjàML Net Guard

The SSRF-safe network boundary for dataset downloads. Every URL an agent or user supplies is treated as hostile input; nothing here performs an unrestricted backend fetch.

## Guarantees

- **HTTPS only.** `http:`, `file:`, `data:`, `ftp:`, `gopher:`, `unix:` / `*+unix:` and every other scheme are refused. Only `https://host/...` authority form is accepted.
- **Administrator allowlist.** Hosts must match an exact name or a `*.suffix` pattern (subdomains only). `DEFAULT_DATASET_POLICY` allows nothing; `parseAllowedHosts` validates the admin list (no IPs, no mid-label or bare wildcards, no local/metadata names).
- **No IP literals.** Canonical IPv4, IPv6 (bracketed, mapped, zone ids) and every non-canonical IPv4 form (`0177.0.0.1`, `0x7f000001`, `2130706433`, `127.1`, leading zeros) are rejected, checked on both the raw authority and the WHATWG-normalized host.
- **No local names.** `localhost`, `*.localhost`, `*.internal` (incl. `metadata.google.internal`), `metadata`, `instance-data`, `*.local`, `*.arpa`, single-label names and malformed labels are refused. Trailing dots are normalized, IDNs are checked in punycode form. Credentials in URLs and non-443 ports (unless configured) are refused.
- **Every DNS answer must be public.** One non-public answer (loopback, RFC 1918, CGNAT, link-local, cloud metadata such as `169.254.169.254` / `fd00:ec2::254`, ULA, multicast, documentation, benchmark, reserved, non-`2000::/3` IPv6) rejects the host. NAT64 and 6to4 addresses are judged by their embedded IPv4; IPv4-mapped IPv6 answers are always refused.
- **DNS pinning.** The socket's `lookup` returns only the validated address, so there is no second resolution to rebind. After connecting, the peer address is compared with the pinned one.
- **Per-hop redirect validation.** Redirects are followed manually (at most `maxRedirects`); every `Location` is resolved against the current URL and goes through URL validation and DNS validation again.
- **TLS stays verified.** `rejectUnauthorized: true`, SNI and certificate hostname checks use the URL hostname. No cookies, no auth headers, no connection pooling (`agent: false`), `Accept-Encoding: identity`.
- **Limits.** Declared `content-length` over the limit is refused before reading; streamed bytes over `maxBytes` abort the transfer; an overall deadline (`timeoutMs`) and socket idle timeout apply; an `AbortSignal` cancels.
- **Atomic, verifiable files.** Data goes to `<dest>.partial` (exclusive create, mode 0600), is SHA-256 hashed while streaming, fsynced and renamed. Existing destinations are never overwritten. The partial file is deleted on every failure, timeout, cancel and checksum mismatch.

The receipt records source URL, final URL, redirect chain, the connected address, SHA-256, byte count, MIME type, time, and whether an expected checksum was verified.

## Not defended / out of scope

- **Proxies are not supported.** The fetcher connects directly and ignores `HTTPS_PROXY`. Deploy it where direct egress to the allowlisted hosts is possible, or front it with an egress firewall.
- **Allowlisted hosts are trusted to serve what they serve.** An allowlisted host that is itself compromised or hosts attacker-controlled files can still deliver hostile content; pass `expectedSha256` when a checksum is known, and treat downloaded data as untrusted.
- **Open redirects on allowlisted hosts** can only lead to other allowlisted, public hosts.
- **Resolver trust.** A resolver that lies with *public* addresses can still route to a public attacker IP; TLS verification is what defends against that.
- **Network-layer egress controls** (firewall, VPC rules blocking metadata endpoints) remain recommended as defence in depth.
- **Content inspection** (archive bombs, malware, format validation) is the caller's job.

## Test seams

`safeDownload` accepts `transport` (same shape as `https.request`) and `addressPolicy` so tests can reach a TLS server on 127.0.0.1 with a throwaway certificate. They are code-level options only; `FetchPolicy` has no field that disables TLS or the address check. Tests separately prove the default policy refuses loopback.

```bash
npm run build --workspace @dejaml/net-guard
npm test --workspace @dejaml/net-guard
```
