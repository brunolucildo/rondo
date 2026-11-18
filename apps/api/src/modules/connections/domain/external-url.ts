import { addressFamily, isPublicAddress } from "./ip-address";

/** Longest link accepted (R1). */
export const MAX_URL_LENGTH = 2048;

const MAX_DISPLAY_NAME_LENGTH = 255;

/** Why a link is refused before any request: a closed set (it is also a metric dimension). */
export type UrlRejection = "malformed" | "scheme" | "port" | "credentials";

/** Why a request was blocked (metric dimension `reason`): the rules of R1 to R3. */
export type UrlBlockReason = "scheme" | "port" | "credentials" | "address" | "redirect";

/** The link breaks a syntax rule: not a URL, not http(s), user and password, or a port other than 80 and 443. */
export class InvalidUrlError extends Error {
  constructor(readonly reason: UrlRejection) {
    super(`Invalid URL: ${reason}`);
    this.name = "InvalidUrlError";
  }
}

/** Where the link points is not a public address (`reason` says whether it was a redirect). */
export class UrlNotAllowedError extends Error {
  constructor(readonly reason: "address" | "redirect" = "address") {
    super("URL not allowed.");
    this.name = "UrlNotAllowedError";
  }
}

/**
 * A link that passed the syntax and host rules. `url` is the canonical form (no fragment, no
 * `utm_*`, sorted query) and is only ever used to make the request: the query may carry secrets,
 * so it is never stored, logged or shown. What is kept is the hash of `canonical` and the
 * `displayName` (host and path).
 */
export interface ExternalUrl {
  readonly url: URL;
  readonly canonical: string;
  readonly displayName: string;
}

/** Names that always mean this machine or its network, whatever a resolver says. */
const BLOCKED_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

function hostnameOf(url: URL): string {
  const host = url.hostname.toLowerCase();

  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** The host without the brackets of an IPv6 literal. */
export function bareHostname(url: URL): string {
  const host = hostnameOf(url);

  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True when the host is an IP address written out (the URL parser already normalised odd forms). */
export function isAddressLiteral(url: URL): boolean {
  return addressFamily(bareHostname(url)) !== null;
}

function assertAllowedHost(url: URL, reason: "address" | "redirect"): void {
  const host = bareHostname(url);

  if (host === "" || BLOCKED_NAME.test(host)) {
    throw new UrlNotAllowedError(reason);
  }

  if (isAddressLiteral(url) && !isPublicAddress(host)) {
    throw new UrlNotAllowedError(reason);
  }
}

function canonicalUrl(parsed: URL): URL {
  const url = new URL(parsed.href);

  url.hash = "";

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_"))
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));

  url.search = kept.length === 0 ? "" : new URLSearchParams(kept).toString();

  return url;
}

function canonicalPath(url: URL): string {
  return url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
}

function readablePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Title or `host/path`, one line, no control characters, at most 255 characters. */
export function sanitizeDisplayName(raw: string, fallback: string): string {
  const printable = Array.from(raw, (character) => (isControl(character) ? " " : character)).join(
    "",
  );
  const name = Array.from(printable.replace(/\s+/g, " ").trim())
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .join("")
    .trim();

  return name === "" ? fallback : name;
}

/**
 * Validates a link (R1, R2) and gives its canonical form (R6) and display name (R7). Only `http`
 * and `https`, no user or password, port 80, 443 or none, and a host that is not `localhost` nor
 * an address outside the public ranges. A name that resolves to a private address is not caught
 * here (it needs the resolver): the fetch client checks it.
 *
 * `base` resolves a relative `Location` of a redirect; `source` then says the link came from one.
 */
export function parseExternalUrl(
  raw: string,
  options: { base?: string; source?: "request" | "redirect" } = {},
): ExternalUrl {
  const source = options.source ?? "request";
  const text = raw.trim();
  let parsed: URL;

  if (text === "" || text.length > MAX_URL_LENGTH) {
    throw new InvalidUrlError("malformed");
  }

  try {
    parsed = new URL(text, options.base);
  } catch {
    throw new InvalidUrlError("malformed");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUrlError("scheme");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new InvalidUrlError("credentials");
  }

  // The parser drops the default port of the scheme, so `http://x:443` keeps it and `http://x:80` does not.
  if (parsed.port !== "" && parsed.port !== "80" && parsed.port !== "443") {
    throw new InvalidUrlError("port");
  }

  assertAllowedHost(parsed, source === "redirect" ? "redirect" : "address");

  const url = canonicalUrl(parsed);
  const path = canonicalPath(url);
  const canonical = `${url.protocol}//${url.host}${path}${url.search}`;
  const fallback = `${url.host}${readablePath(path)}`;

  return {
    url,
    canonical,
    displayName: sanitizeDisplayName(fallback, hostnameOf(url)),
  };
}
