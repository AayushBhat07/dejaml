import { promises as dnsPromises, type LookupAddress, type LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

import { NetGuardError } from "./errors.js";
import { isPublicAddress, parseIpLiteral } from "./ip.js";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Decides whether a resolved address may be contacted. Tests may widen it; production must not. */
export type AddressPolicy = (ip: string) => boolean;

export interface ResolvedHost {
  readonly hostname: string;
  readonly addresses: readonly ResolvedAddress[];
  /** The single address the connection is pinned to. */
  readonly pinned: ResolvedAddress;
}

/** System resolver (`getaddrinfo`) returning every answer in resolver order. */
export const defaultResolver: Resolver = async (hostname) => {
  const answers = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
};

/**
 * Resolves a hostname and requires every answer to be acceptable. A single
 * private answer rejects the whole name, so a mixed record set cannot be used
 * to reach internal hosts by retrying.
 */
export async function resolvePublic(
  hostname: string,
  resolver: Resolver = defaultResolver,
  addressPolicy: AddressPolicy = isPublicAddress,
): Promise<ResolvedHost> {
  let answers: ResolvedAddress[];
  try {
    answers = await resolver(hostname);
  } catch (cause) {
    throw new NetGuardError("dns_failed", `DNS resolution failed for ${hostname}`, { cause });
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new NetGuardError("dns_failed", `DNS returned no addresses for ${hostname}`);
  }
  const addresses: ResolvedAddress[] = [];
  for (const answer of answers) {
    const parsed = parseIpLiteral(answer.address);
    if (parsed === null || parsed.family !== answer.family) {
      throw new NetGuardError("dns_failed", `DNS returned a malformed address for ${hostname}`);
    }
    if (!addressPolicy(answer.address)) {
      throw new NetGuardError(
        "private_address",
        `${hostname} resolves to a non-public address (${answer.address})`,
      );
    }
    addresses.push({ address: answer.address, family: parsed.family });
  }
  const pinned = addresses[0];
  if (pinned === undefined) {
    throw new NetGuardError("dns_failed", `DNS returned no addresses for ${hostname}`);
  }
  return { hostname, addresses, pinned };
}

/**
 * Builds a `lookup` for `https.request` that answers only with the
 * pre-validated address, so the socket never performs a second, unvalidated
 * resolution (DNS-rebinding defence). Any other hostname is refused.
 */
export function createPinnedLookup(hostname: string, pinned: ResolvedAddress): LookupFunction {
  const expected = hostname.toLowerCase();
  return (requested: string, options: LookupOptions, callback) => {
    if (requested.toLowerCase() !== expected) {
      const error: NodeJS.ErrnoException = new NetGuardError(
        "pinning_violation",
        `Pinned lookup for ${expected} was asked to resolve ${requested}`,
      );
      process.nextTick(callback, error, "", 0);
      return;
    }
    if (options.all === true) {
      const all: LookupAddress[] = [{ address: pinned.address, family: pinned.family }];
      process.nextTick(callback, null, all);
      return;
    }
    process.nextTick(callback, null, pinned.address, pinned.family);
  };
}
