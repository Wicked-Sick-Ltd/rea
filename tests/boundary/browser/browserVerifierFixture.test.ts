import { createServer } from "node:http";
import { createConnection } from "node:net";
import { describe, it, expect } from "vitest";
import { startBrowserVerifierSite } from "../../../scripts/fixtures/browser-verifier-site.mjs";

const pageCdpProxyModuleUrl = new URL(
  "../../../scripts/fixtures/page-cdp-proxy.mjs",
  import.meta.url,
).href;
const serviceWorkerSetupModuleUrl = new URL(
  "../../../scripts/lib/browser-scenario-service-worker-setup-e2e.mjs",
  import.meta.url,
).href;

it("closes an accepted HTTP socket that has not sent request headers", async () => {
  const site = await startBrowserVerifierSite();
  const { port } = new URL(site.origin);
  const socket = createConnection(Number(port), "127.0.0.1");
  let close: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const closing = site.close();
    close = closing;
    const closedBeforeDeadline = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    expect(closedBeforeDeadline).toBe(true);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    socket.destroy();
    await (close ?? site.close());
  }
});

describe("CDP verifier proxy URL validation", () => {
  it("allows only loopback 127.0.0.1 CDP discovery paths and blocks SSRF targets", async () => {
    const { resolvePageCdpProxyUrl, startPageCdpProxy } = (await import(
      pageCdpProxyModuleUrl
    )) as {
      resolvePageCdpProxyUrl: (
        endpoint: unknown,
        path: unknown,
      ) => string | undefined;
      startPageCdpProxy: (upstreamEndpoint: string) => Promise<{
        readonly endpoint: string;
        close(): Promise<void>;
      }>;
    };
    const { resolveCdpDiscoveryProxyUrl } = (await import(
      serviceWorkerSetupModuleUrl
    )) as {
      resolveCdpDiscoveryProxyUrl: (
        endpoint: unknown,
        requestUrl: unknown,
      ) => URL | undefined;
    };

    expect(
      resolvePageCdpProxyUrl("http://127.0.0.1:9222", "/json/version"),
    ).toBe("http://127.0.0.1:9222/json/version");
    expect(resolvePageCdpProxyUrl("http://127.0.0.1:9222", "/json/list")).toBe(
      "http://127.0.0.1:9222/json/list",
    );
    expect(
      resolveCdpDiscoveryProxyUrl("http://127.0.0.1:9222", "/json/version/")
        ?.href,
    ).toBe("http://127.0.0.1:9222/json/version/");
    expect(
      resolveCdpDiscoveryProxyUrl("http://127.0.0.1:9222", "/json/list")?.href,
    ).toBe("http://127.0.0.1:9222/json/list");

    for (const blockedEndpoint of [
      "http://169.254.169.254:80",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost:9222",
      "http://10.0.0.1:9222",
      "http://192.168.1.1:9222",
      "file:///etc/passwd",
      "https://127.0.0.1:9222",
      "http://user:pass@127.0.0.1:9222",
      "http://127.0.0.1:9222/extra",
    ]) {
      expect(
        resolvePageCdpProxyUrl(blockedEndpoint, "/json/version"),
      ).toBeUndefined();
      expect(
        resolveCdpDiscoveryProxyUrl(blockedEndpoint, "/json/version"),
      ).toBeUndefined();
    }

    for (const blockedPath of [
      "http://169.254.169.254/latest/meta-data",
      "http://localhost:9222/json/version",
      "file:///etc/passwd",
      "//169.254.169.254/json/version",
      "/json/../secret",
      "/json/version?token=1",
      "/json/new",
    ]) {
      expect(
        resolvePageCdpProxyUrl("http://127.0.0.1:9222", blockedPath),
      ).toBeUndefined();
      expect(
        resolveCdpDiscoveryProxyUrl("http://127.0.0.1:9222", blockedPath),
      ).toBeUndefined();
    }

    const upstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/json/list") {
        res.end(
          JSON.stringify([
            {
              id: "page-1",
              type: "page",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1",
            },
          ]),
        );
      } else {
        res.end(
          JSON.stringify({
            Browser: "Chrome/Test",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/b-1",
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP address");
    const proxy = await startPageCdpProxy(
      `http://127.0.0.1:${String(address.port)}`,
    );
    try {
      const okResponse = await fetch(`${proxy.endpoint}/json/version`);
      expect(okResponse.status).toBe(200);
      const blockedResponse = await fetch(`${proxy.endpoint}/json/new`);
      expect(blockedResponse.status).toBe(404);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((err) => (err === undefined ? resolve() : reject(err))),
      );
    }
  });
});
