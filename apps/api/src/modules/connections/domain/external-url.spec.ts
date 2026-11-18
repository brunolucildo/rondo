import { describe, expect, it } from "vitest";
import {
  InvalidUrlError,
  parseExternalUrl,
  sanitizeDisplayName,
  UrlNotAllowedError,
} from "./external-url";

const reasonOf = (raw: string): unknown => {
  try {
    parseExternalUrl(raw);
  } catch (error) {
    return error instanceof InvalidUrlError || error instanceof UrlNotAllowedError
      ? `${error.name}:${error.reason}`
      : error;
  }

  return "accepted";
};

describe("parseExternalUrl: what is refused before any request (R1, R2)", () => {
  it.each([
    ["ftp://example.com/file", "InvalidUrlError:scheme"],
    ["file:///etc/passwd", "InvalidUrlError:scheme"],
    ["javascript:alert(1)", "InvalidUrlError:scheme"],
    ["gopher://example.com", "InvalidUrlError:scheme"],
    ["http://user:pw@example.com/", "InvalidUrlError:credentials"],
    ["https://user@example.com/", "InvalidUrlError:credentials"],
    ["http://example.com:5432/", "InvalidUrlError:port"],
    ["http://example.com:8080/", "InvalidUrlError:port"],
    ["https://example.com:3002/", "InvalidUrlError:port"],
    ["example.com/page", "InvalidUrlError:malformed"],
    ["", "InvalidUrlError:malformed"],
    ["   ", "InvalidUrlError:malformed"],
    ["http://", "InvalidUrlError:malformed"],
    [`https://example.com/${"a".repeat(2050)}`, "InvalidUrlError:malformed"],
  ])("%s -> %s", (raw, expected) => {
    expect(reasonOf(raw)).toBe(expected);
  });

  it.each([
    "http://localhost",
    "http://localhost:80/",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://127.0.0.1",
    "http://127.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:7f00:1]",
    "http://10.0.0.5",
    "http://192.168.1.1",
    "http://172.16.5.5",
    "http://169.254.169.254",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "http://100.64.0.1",
    "http://0x7f.1",
    "http://0x7f000001",
    "http://2130706433",
    "http://017700000001",
    "http://0177.0.0.1",
    "http://0.0.0.0",
    "http://224.0.0.1",
    "http://printer.local/",
    "http://db.internal/",
  ])("%s is not allowed", (raw) => {
    expect(reasonOf(raw)).toBe("UrlNotAllowedError:address");
  });

  it("accepts ports 80 and 443 on either scheme and public hosts", () => {
    expect(reasonOf("http://example.com")).toBe("accepted");
    expect(reasonOf("https://example.com:443/x")).toBe("accepted");
    expect(reasonOf("http://example.com:443/x")).toBe("accepted");
    expect(reasonOf("https://example.com:80/x")).toBe("accepted");
    expect(reasonOf("https://93.184.216.34/")).toBe("accepted");
    expect(reasonOf("https://[2606:4700:4700::1111]/")).toBe("accepted");
    expect(reasonOf("https://exemplo.com.br/relatório")).toBe("accepted");
  });

  it("marks a link that came from a redirect as such", () => {
    expect(() =>
      parseExternalUrl("http://10.0.0.1/", { base: "https://example.com/", source: "redirect" }),
    ).toThrow(expect.objectContaining({ reason: "redirect" }));
  });

  it("resolves a relative redirect target against the current link", () => {
    expect(
      parseExternalUrl("/next?b=2&a=1", { base: "https://example.com/start", source: "redirect" })
        .canonical,
    ).toBe("https://example.com/next?a=1&b=2");
  });
});

describe("parseExternalUrl: canonical form and display name (R6, R7)", () => {
  const canonicalOf = (raw: string) => parseExternalUrl(raw).canonical;

  it("lower-cases scheme and host, drops the fragment, the default port and the trailing slash", () => {
    expect(canonicalOf("HTTPS://Example.COM:443/Doc/#section")).toBe("https://example.com/Doc");
    expect(canonicalOf("http://example.com:80/")).toBe("http://example.com");
    expect(canonicalOf("http://example.com")).toBe("http://example.com");
    expect(canonicalOf("https://example.com/a//")).toBe("https://example.com/a");
  });

  it("removes utm_ parameters and sorts the others", () => {
    expect(canonicalOf("https://example.com/p?utm_source=x&b=2&UTM_medium=y&a=1")).toBe(
      "https://example.com/p?a=1&b=2",
    );
    expect(canonicalOf("https://example.com/p?utm_campaign=z")).toBe("https://example.com/p");
  });

  it("gives the same canonical form to a link, its fragment and its tracking", () => {
    const plain = canonicalOf("https://example.com/regulation");

    expect(canonicalOf("https://example.com/regulation#sec")).toBe(plain);
    expect(canonicalOf("https://example.com/regulation?utm_source=x")).toBe(plain);
    expect(canonicalOf("https://EXAMPLE.com/regulation/")).toBe(plain);
  });

  it("keeps a different query as a different link", () => {
    expect(canonicalOf("https://example.com/p?id=1")).not.toBe(
      canonicalOf("https://example.com/p?id=2"),
    );
  });

  it("shows host and path only: no query, no fragment", () => {
    const { displayName } = parseExternalUrl("https://x.test/doc/?token=SEGREDO#a");

    expect(displayName).toBe("x.test/doc");
    expect(displayName).not.toContain("SEGREDO");
    expect(parseExternalUrl("https://x.test/").displayName).toBe("x.test");
    expect(parseExternalUrl("https://x.test/relat%C3%B3rio").displayName).toBe("x.test/relatório");
  });

  it("limits the display name to 255 characters", () => {
    expect(parseExternalUrl(`https://x.test/${"a".repeat(600)}`).displayName).toHaveLength(255);
  });
});

describe("sanitizeDisplayName", () => {
  it("collapses whitespace, drops control characters and falls back when empty", () => {
    expect(sanitizeDisplayName("  Match \n\t regulation\u0000  ", "x")).toBe("Match regulation");
    expect(sanitizeDisplayName(" \n ", "fallback")).toBe("fallback");
    expect(sanitizeDisplayName("a".repeat(300), "x")).toHaveLength(255);
  });
});
