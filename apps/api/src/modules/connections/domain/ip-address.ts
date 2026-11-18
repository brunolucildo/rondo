/**
 * Which addresses the API may connect to when it fetches a link (spec 0027, R2). The rule is an
 * allow-list for IPv6 (only global unicast outside the special blocks) and a block-list of every
 * special-purpose range for IPv4. An address that cannot be parsed is never public.
 *
 * Pure functions on text: no `node:net`, so the domain stays free of Node built-ins.
 */

type Quad = readonly [number, number, number, number];

/** `a.b.c.d` with decimal parts from 0 to 255 and no leading zeros (the form the resolver gives). */
export function parseIpv4(text: string): Quad | null {
  const parts = text.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const numbers = parts.map((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : Number.NaN,
  );

  if (numbers.some((value) => !(value >= 0 && value <= 255))) {
    return null;
  }

  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0];
}

/** Eight 16-bit groups of an IPv6 address (any textual form, with `::` and an IPv4 tail). */
export function parseIpv6(text: string): readonly number[] | null {
  // A zone id (`fe80::1%eth0`) only exists for link-local addresses: never public, never parsed.
  if (text.includes("%") || !text.includes(":")) {
    return null;
  }

  let source = text;

  if (source.includes(".")) {
    const split = source.lastIndexOf(":");
    const quad = parseIpv4(source.slice(split + 1));

    if (quad === null) {
      return null;
    }

    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);

    source = `${source.slice(0, split + 1)}${high}:${low}`;
  }

  const halves = source.split("::");

  if (halves.length > 2) {
    return null;
  }

  const toGroups = (half: string): string[] => (half === "" ? [] : half.split(":"));
  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;

  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }

  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...tail,
  ];

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }

  return groups.map((group) => Number.parseInt(group, 16));
}

/** Special-purpose IPv4 ranges: nothing here is a public host the API may reach. */
function isPublicIpv4([a, b, c]: Quad): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return false; // this network, private, loopback, multicast, reserved and broadcast
  }

  if (a === 100 && b >= 64 && b <= 127) {
    return false; // CGNAT 100.64.0.0/10
  }

  if (a === 169 && b === 254) {
    return false; // link-local, including the cloud metadata address 169.254.169.254
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }

  if (a === 192 && b === 168) {
    return false;
  }

  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return false; // 192.0.0.0/24 (protocol assignments) and 192.0.2.0/24 (documentation)
  }

  if (a === 192 && b === 88 && c === 99) {
    return false; // 6to4 relay anycast (deprecated)
  }

  if (a === 198 && (b === 18 || b === 19)) {
    return false; // benchmarking 198.18.0.0/15
  }

  if (a === 198 && b === 51 && c === 100) {
    return false; // documentation
  }

  if (a === 203 && b === 0 && c === 113) {
    return false; // documentation
  }

  return true;
}

const fromGroups = (high: number, low: number): Quad => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

function isPublicIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  // ::ffff:a.b.c.d (IPv4-mapped): it is the IPv4 address, judged as such.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIpv4(fromGroups(g6, g7));
  }

  // 64:ff9b::/96 (NAT64): the embedded IPv4 address decides.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIpv4(fromGroups(g6, g7));
  }

  // 2002::/16 (6to4): the IPv4 address sits in the next 32 bits.
  if (g0 === 0x2002) {
    return isPublicIpv4(fromGroups(g1, g2));
  }

  // Only global unicast, 2000::/3. That leaves out ::, ::1, fc00::/7, fe80::/10, ff00::/8, ...
  if ((g0 & 0xe000) !== 0x2000) {
    return false;
  }

  if (g0 === 0x2001 && (g1 < 0x0200 || g1 === 0x0db8)) {
    return false; // 2001::/23 (Teredo, benchmarking, ORCHID...) and 2001:db8::/32 (documentation)
  }

  if (g0 === 0x3fff && (g1 & 0xf000) === 0) {
    return false; // 3fff::/20 (documentation)
  }

  return true;
}

/**
 * True when `address` is a public unicast address the API may connect to. An IPv6 address with an
 * IPv4 inside (`::ffff:127.0.0.1`) counts as that IPv4 address.
 */
export function isPublicAddress(address: string): boolean {
  const host = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const quad = parseIpv4(host);

  if (quad !== null) {
    return isPublicIpv4(quad);
  }

  const groups = parseIpv6(host);

  return groups !== null && isPublicIpv6(groups);
}

/** `4`, `6` or `null`: which family the text is, when it is an address literal. */
export function addressFamily(address: string): 4 | 6 | null {
  const host = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;

  if (parseIpv4(host) !== null) {
    return 4;
  }

  return parseIpv6(host) === null ? null : 6;
}
