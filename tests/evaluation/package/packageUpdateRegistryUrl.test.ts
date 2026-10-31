import { describe, expect, it } from "vitest";

import {
  isBlockedOutboundHost,
  npmRegistryUrl,
  validateOutboundHttpUrl,
} from "../../../scripts/verify-package-update.mjs";

describe("outbound host and IP blocking", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "sub.localhost",
    "service.local",
    "metadata.google.internal",
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "169.254.169.254",
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.1.254",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "[::1]",
    "::1",
    "[::]",
    "[fe80::1]",
    "[fe80::1%25eth0]",
    "[fc00::1]",
    "[fd12:3456:789a::1]",
    "[ff02::1]",
    "[2001:db8::1]",
    "::ffff:169.254.169.254",
    "[::ffff:a9fe:a9fe]",
    "[::ffff:7f00:1]",
    "",
  ])("blocks private, loopback, link-local, or reserved host %s", (host) => {
    expect(isBlockedOutboundHost(host)).toBe(true);
  });

  it.each([
    "registry.npmjs.org",
    "example.com",
    "8.8.8.8",
    "[2606:4700:4700::1111]",
  ])("allows public host %s", (host) => {
    expect(isBlockedOutboundHost(host)).toBe(false);
  });
});

describe("validateOutboundHttpUrl", () => {
  it("accepts allowed public http(s) URLs", () => {
    expect(
      validateOutboundHttpUrl("https://registry.npmjs.org/rea-agents", {
        allowedHosts: ["registry.npmjs.org"],
        allowHttp: false,
      }),
    ).toBe("https://registry.npmjs.org/rea-agents");
    expect(
      validateOutboundHttpUrl("http://example.com/resource", {
        allowedHosts: new Set(["example.com"]),
        allowHttp: true,
      }),
    ).toBe("http://example.com/resource");
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://localhost/admin",
    "https://localhost:8443/internal",
    "http://sub.localhost/internal",
    "http://127.0.0.1:8080/json/version",
    "http://[::1]:9222/json/list",
    "http://10.0.0.1/private",
    "http://172.16.0.1/private",
    "http://192.168.1.1/private",
    "http://0.0.0.0/private",
    "http://[fe80::1]/link-local",
    "http://[fc00::1]/unique-local",
    "file:///etc/passwd",
    "file://localhost/etc/passwd",
    "ftp://registry.npmjs.org/package.tgz",
    "ws://localhost:9222/devtools/browser/id",
    "wss://registry.npmjs.org/socket",
    "data:application/json,{}",
    "javascript:alert(1)",
    "https://user:pass@registry.npmjs.org/rea-agents",
    "https://registry.npmjs.org/rea-agents#fragment",
    "https://registry.npmjs.org\\@169.254.169.254/meta-data",
  ])("rejects blocked URL %s", (candidate) => {
    expect(validateOutboundHttpUrl(candidate)).toBeUndefined();
  });

  it("enforces HTTPS-only and host allow-lists when configured", () => {
    expect(
      validateOutboundHttpUrl("http://registry.npmjs.org/rea-agents", {
        allowedHosts: ["registry.npmjs.org"],
        allowHttp: false,
      }),
    ).toBeUndefined();
    expect(
      validateOutboundHttpUrl("https://evil.example/rea-agents", {
        allowedHosts: ["registry.npmjs.org"],
        allowHttp: false,
      }),
    ).toBeUndefined();
  });
});

describe("npmRegistryUrl", () => {
  it.each([
    ["/zod", "https://registry.npmjs.org/zod"],
    [
      "/@modelcontextprotocol/sdk",
      "https://registry.npmjs.org/%40modelcontextprotocol/sdk",
    ],
    [
      "/@modelcontextprotocol%2fsdk",
      "https://registry.npmjs.org/%40modelcontextprotocol%2Fsdk",
    ],
    ["/zod/-/zod-4.4.3.tgz", "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz"],
    [
      "/@scope/pkg/-/pkg-1.0.0.tgz",
      "https://registry.npmjs.org/%40scope/pkg/-/pkg-1.0.0.tgz",
    ],
    ["https://registry.npmjs.org/zod", "https://registry.npmjs.org/zod"],
  ])("maps allowed registry path %s to %s", (input, expected) => {
    expect(npmRegistryUrl(input)).toBe(expected);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/latest/meta-data/",
    "//169.254.169.254/latest/meta-data/",
    "/@169.254.169.254/latest/meta-data",
    "http://localhost:8080/rea-agents",
    "https://localhost/rea-agents",
    "http://127.0.0.1/rea-agents",
    "file:///etc/passwd",
    "ftp://registry.npmjs.org/rea-agents",
    "http://registry.npmjs.org/rea-agents",
    "https://evil.example/rea-agents",
    "https://registry.npmjs.org:8443/rea-agents",
    "https://registry.npmjs.org/rea-agents?write=true",
    "/",
    "/..",
    "/zod/../secret",
    "/zod/%2e%2e/secret",
    "/zod?token=secret",
    "/zod#fragment",
    "/a/b/c/d/e",
    "",
  ])("blocks disallowed or forged registry input %s", (input) => {
    expect(npmRegistryUrl(input)).toBeUndefined();
  });
});
