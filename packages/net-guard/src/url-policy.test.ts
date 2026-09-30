import { describe, expect, it } from "vitest";

import { NetGuardError, type NetGuardErrorCode } from "./errors.js";
import { type FetchPolicy, validateFetchUrl } from "./url-policy.js";

const policy: FetchPolicy = {
  allowedHosts: ["allowed.example.test", "*.mirror.example.test"],
  maxRedirects: 3,
  maxBytes: 1024,
  timeoutMs: 5_000,
};

function rejection(raw: string, overrides: Partial<FetchPolicy> = {}): NetGuardErrorCode {
  try {
    validateFetchUrl(raw, { ...policy, ...overrides });
  } catch (error) {
    expect(error).toBeInstanceOf(NetGuardError);
    return (error as NetGuardError).code;
  }
  throw new Error(`expected ${raw} to be rejected`);
}

describe("validateFetchUrl rejections", () => {
  it("rejects https://localhost/", () => {
    expect(rejection("https://localhost/")).toBe("unsafe_hostname");
  });
  it("rejects https://127.0.0.1/", () => {
    expect(rejection("https://127.0.0.1/")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://[::1]/", () => {
    expect(rejection("https://[::1]/")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://10.0.0.5/", () => {
    expect(rejection("https://10.0.0.5/")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://172.16.3.4/", () => {
    expect(rejection("https://172.16.3.4/")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://192.168.1.1/", () => {
    expect(rejection("https://192.168.1.1/")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://169.254.169.254/latest/meta-data", () => {
    expect(rejection("https://169.254.169.254/latest/meta-data")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://[fe80::1]/", () => {
    expect(rejection("https://[fe80::1]/")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://[fd00::1]/", () => {
    expect(rejection("https://[fd00::1]/")).toBe("ip_literal_not_allowed");
  });
  it("rejects https://[::ffff:127.0.0.1]/", () => {
    expect(rejection("https://[::ffff:127.0.0.1]/")).toBe("ip_literal_not_allowed");
  });
  it("rejects octal https://0177.0.0.1/", () => {
    expect(rejection("https://0177.0.0.1/")).toBe("ip_literal_not_allowed");
  });
  it("rejects hex https://0x7f000001/", () => {
    expect(rejection("https://0x7f000001/")).toBe("ip_literal_not_allowed");
  });
  it("rejects integer https://2130706433/", () => {
    expect(rejection("https://2130706433/")).toBe("ip_literal_not_allowed");
  });
  it("rejects short form https://127.1/", () => {
    expect(rejection("https://127.1/")).toBe("ip_literal_not_allowed");
  });
  it("rejects IPv6 zone ids", () => {
    expect(["invalid_url", "ip_literal_not_allowed"]).toContain(rejection("https://[fe80::1%25eth0]/"));
  });
  it("rejects non-HTTPS http://allowed.example.test/", () => {
    expect(rejection("http://allowed.example.test/")).toBe("scheme_not_allowed");
  });
  it("rejects credentials https://user:pass@allowed.example.test/", () => {
    expect(rejection("https://user:pass@allowed.example.test/")).toBe("credentials_in_url");
  });
  it("rejects file:///etc/passwd", () => {
    expect(rejection("file:///etc/passwd")).toBe("scheme_not_allowed");
  });
  it.each(["data:text/plain,hi", "ftp://allowed.example.test/x", "gopher://allowed.example.test/", "javascript:alert(1)"])(
    "rejects scheme %s",
    (raw) => {
      expect(rejection(raw)).toBe("scheme_not_allowed");
    },
  );
  it.each(["unix:/var/run/docker.sock", "http+unix://%2Fvar%2Frun%2Fdocker.sock/info"])(
    "rejects unix socket URL %s",
    (raw) => {
      expect(rejection(raw)).toBe("unix_socket");
    },
  );
  it("rejects percent-encoded socket paths in the host", () => {
    expect(rejection("https://%2Fvar%2Frun%2Fdocker.sock/info")).toBe("invalid_url");
  });
  it("rejects a host not in the allowlist", () => {
    expect(rejection("https://evil.example.com/data.csv")).toBe("host_not_allowed");
  });
  it("rejects the bare wildcard suffix itself", () => {
    expect(rejection("https://mirror.example.test/")).toBe("host_not_allowed");
  });
  it("rejects suffix confusion", () => {
    expect(rejection("https://allowed.example.test.evil.com/")).toBe("host_not_allowed");
    expect(rejection("https://evilmirror.example.test/")).toBe("host_not_allowed");
  });
  it("rejects non-default ports", () => {
    expect(rejection("https://allowed.example.test:8443/")).toBe("port_not_allowed");
  });
  it.each([
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://metadata/",
    "https://instance-data/latest",
    "https://db.internal/",
    "https://app.localhost/",
    "https://localhost./",
  ])("rejects unsafe hostname %s", (raw) => {
    expect(rejection(raw, { allowedHosts: ["*.internal", "*.localhost", "localhost", "metadata"] })).toBe(
      "unsafe_hostname",
    );
  });
  it("rejects empty labels and single-label names", () => {
    expect(["invalid_url", "unsafe_hostname"]).toContain(rejection("https://allowed..example.test/"));
    expect(rejection("https://intranet/")).toBe("unsafe_hostname");
  });
  it("rejects whitespace and backslash tricks", () => {
    expect(rejection("https://allowed.example.test\\@evil.com/")).toBe("invalid_url");
    expect(rejection("https://allowed.example.test/\n")).toBe("invalid_url");
    expect(rejection("https:allowed.example.test/")).toBe("invalid_url");
  });
  it("checks non-ASCII hosts after punycode conversion", () => {
    expect(rejection("https://bücher.example.test/")).toBe("host_not_allowed");
    expect(validateFetchUrl("https://bücher.example.test/", { ...policy, allowedHosts: ["xn--bcher-kva.example.test"] }).hostname).toBe(
      "xn--bcher-kva.example.test",
    );
  });
});

describe("validateFetchUrl acceptance", () => {
  it("accepts an allowlisted https URL and normalizes it", () => {
    const url = validateFetchUrl("https://ALLOWED.example.test./data/file.csv?x=1#frag", policy);
    expect(url.href).toBe("https://allowed.example.test/data/file.csv?x=1");
  });
  it("accepts wildcard subdomains", () => {
    expect(validateFetchUrl("https://eu.mirror.example.test/a", policy).hostname).toBe("eu.mirror.example.test");
  });
  it("accepts explicit port 443 and configured ports", () => {
    expect(validateFetchUrl("https://allowed.example.test:443/", policy).port).toBe("");
    expect(validateFetchUrl("https://allowed.example.test:8443/", { ...policy, allowedPorts: [8443] }).port).toBe("8443");
  });
});
