/**
 * A last line of defence for text shown on the dashboard. The server already
 * publishes only public summaries, sanitized tool inputs, and bounded logs; this
 * masks anything that still looks like a credential or a private host path and
 * bounds the length, so a log line can never put a key or a home directory on
 * screen.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Authorization headers and bearer tokens.
  [/\b(authorization|proxy-authorization)\s*[:=]\s*\S+(\s+\S+)?/giu, "$1: [redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [redacted]"],
  // NAME_KEY=value / api_key: value / "token": "value".
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|credential)[A-Za-z0-9_]*)("?\s*[:=]\s*"?)([^\s"',;[\]]{4,})/giu,
    "$1$2[redacted]",
  ],
  // Provider-style keys (sk-..., sk-ant-..., ghp_..., xox..., AKIA...).
  [/\b(sk|rk|pk)-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/gu, "[redacted key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/gu, "[redacted token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted key]"],
];

/** Host paths that would reveal the server's user or layout; lab paths (/workspace/...) stay visible. */
const HOST_PATH =
  /(?:\/home\/[^/\s"']+|\/Users\/[^/\s"']+|\/root|\/var\/folders\/[^\s"']+|\/private\/var\/[^\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/gu;

export function redact(text: string, maxLength = 2_000): string {
  let value = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  value = value.replace(HOST_PATH, "[host path]");
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/** A command as one line: program and arguments, redacted and bounded. */
export function describeArgv(executable: string, args: readonly string[], maxLength = 240): string {
  // The lab runs a venv's python through `env --`; show the program the person cares about.
  const parts = executable === "env" && args[0] === "--" ? args.slice(1) : [executable, ...args];
  const text = parts.map((part) => (/[\s"']/u.test(part) ? JSON.stringify(part.replace(/\s+/gu, " ").slice(0, 80)) : part)).join(" ");
  return redact(text, maxLength);
}
