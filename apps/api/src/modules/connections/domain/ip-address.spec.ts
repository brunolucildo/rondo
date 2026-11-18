import { describe, expect, it } from "vitest";
import { addressFamily, isPublicAddress, parseIpv4, parseIpv6 } from "./ip-address";

describe("isPublicAddress: IPv4", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.5",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.10",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "169.253.0.1",
    "192.169.0.1",
    "198.17.0.1",
    "198.20.0.1",
  ])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("isPublicAddress: IPv6", () => {
  it.each([
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "ff00::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.5",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:5",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::1",
    "2001::1",
    "2001:db8::1",
    "2001:1::1",
    "3fff::1",
    "100::1",
    "5f00::1",
    "not-an-address",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:81b::200e",
    "2001:200::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "[2606:4700:4700::1111]",
  ])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("address parsing", () => {
  it("parses the compressed and the embedded forms of IPv6", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1:2:3:4:5:6:7::")).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });

  it("rejects what is not an address", () => {
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.256")).toBeNull();
    expect(parseIpv4("01.2.3.4")).toBeNull();
    expect(parseIpv4("0x7f.0.0.1")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull();
    expect(parseIpv6("12345::")).toBeNull();
    expect(parseIpv6("::g")).toBeNull();
    expect(parseIpv6("1.2.3.4")).toBeNull();
  });

  it("tells the family of a literal", () => {
    expect(addressFamily("8.8.8.8")).toBe(4);
    expect(addressFamily("[::1]")).toBe(6);
    expect(addressFamily("example.com")).toBeNull();
  });
});
