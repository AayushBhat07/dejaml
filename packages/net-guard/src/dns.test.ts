import type { LookupAddress } from "node:dns";

import { describe, expect, it } from "vitest";

import { createPinnedLookup, type Resolver, resolvePublic } from "./dns.js";
import { NetGuardError } from "./errors.js";

function fixed(answers: Array<{ address: string; family: 4 | 6 }>): Resolver {
  return async () => answers;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NetGuardError);
    return (error as NetGuardError).code;
  }
  throw new Error("expected rejection");
}

describe("resolvePublic", () => {
  it("returns public answers and pins the first", async () => {
    const resolved = await resolvePublic(
      "data.example.test",
      fixed([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ]),
    );
    expect(resolved.pinned).toEqual({ address: "93.184.216.34", family: 4 });
    expect(resolved.addresses).toHaveLength(2);
  });

  it("rejects a hostname whose resolver returns a private address", async () => {
    expect(await code(resolvePublic("data.example.test", fixed([{ address: "10.0.0.7", family: 4 }])))).toBe("private_address");
  });

  it("rejects when one answer is public and another private", async () => {
    const resolver = fixed([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await code(resolvePublic("data.example.test", resolver))).toBe("private_address");
  });

  it("rejects IPv6 metadata and mapped answers", async () => {
    expect(await code(resolvePublic("x.example.test", fixed([{ address: "fd00:ec2::254", family: 6 }])))).toBe("private_address");
    expect(await code(resolvePublic("x.example.test", fixed([{ address: "::ffff:169.254.169.254", family: 6 }])))).toBe("private_address");
  });

  it("maps resolver errors, empty answers and malformed answers to dns_failed", async () => {
    expect(
      await code(
        resolvePublic("x.example.test", async () => {
          throw new Error("ENOTFOUND");
        }),
      ),
    ).toBe("dns_failed");
    expect(await code(resolvePublic("x.example.test", fixed([])))).toBe("dns_failed");
    expect(await code(resolvePublic("x.example.test", fixed([{ address: "fe80::1%eth0", family: 6 }])))).toBe("dns_failed");
    expect(await code(resolvePublic("x.example.test", fixed([{ address: "8.8.8.8", family: 6 }])))).toBe("dns_failed");
  });
});

describe("createPinnedLookup", () => {
  const lookup = createPinnedLookup("data.example.test", { address: "93.184.216.34", family: 4 });

  it("answers single lookups with the pinned address", async () => {
    const result = await new Promise<[string, number | undefined]>((resolve, reject) =>
      lookup("data.example.test", {}, (error, address, family) => (error ? reject(error) : resolve([address as string, family]))),
    );
    expect(result).toEqual(["93.184.216.34", 4]);
  });

  it("answers all:true lookups with only the pinned address", async () => {
    const result = await new Promise<LookupAddress[]>((resolve, reject) =>
      lookup("DATA.example.test", { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses as LookupAddress[]))),
    );
    expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses to resolve any other hostname", async () => {
    const error = await new Promise<unknown>((resolve) => lookup("evil.example.test", {}, (err) => resolve(err)));
    expect((error as NetGuardError).code).toBe("pinning_violation");
  });
});
