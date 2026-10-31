import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const ALLOWED_UPSTREAM_HOSTS = new Set(["registry.npmjs.org"]);
const PACKAGE_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const SCOPE_SEGMENT = /^@[A-Za-z0-9._~-]+$/u;
const ENCODED_SCOPED_PACKAGE = /^@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+$/u;
const TARBALL_SEGMENT = /^[A-Za-z0-9._~-]+\.tgz$/u;

function isValidRegistrySegments(segments) {
  if (
    segments.length === 0 ||
    segments.length > 4 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    return false;
  if (segments.length === 1) {
    return (
      PACKAGE_SEGMENT.test(segments[0]) ||
      ENCODED_SCOPED_PACKAGE.test(segments[0])
    );
  }
  if (segments.length === 2) {
    return SCOPE_SEGMENT.test(segments[0]) && PACKAGE_SEGMENT.test(segments[1]);
  }
  if (segments.length === 3) {
    return (
      PACKAGE_SEGMENT.test(segments[0]) &&
      segments[1] === "-" &&
      TARBALL_SEGMENT.test(segments[2])
    );
  }
  return (
    SCOPE_SEGMENT.test(segments[0]) &&
    PACKAGE_SEGMENT.test(segments[1]) &&
    segments[2] === "-" &&
    TARBALL_SEGMENT.test(segments[3])
  );
}

function isBlockedIpv4(host) {
  if (!isIPv4(host)) return false;
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(host) {
  const dotted = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/iu.exec(
    host,
  );
  if (dotted !== null) return dotted[1];
  const hex =
    /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(host);
  if (hex === null) return undefined;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${String((hi >> 8) & 0xff)}.${String(hi & 0xff)}.${String((lo >> 8) & 0xff)}.${String(lo & 0xff)}`;
}

/** Reject localhost, loopback, link-local, private, and reserved IP literals or internal hostnames. */
export function isBlockedOutboundHost(hostname) {
  if (typeof hostname !== "string") return true;
  const raw = hostname.trim().toLowerCase();
  if (raw === "") return true;
  const unbracketed =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (unbracketed.includes("%")) return true;
  if (
    unbracketed === "localhost" ||
    unbracketed.endsWith(".localhost") ||
    unbracketed.endsWith(".local") ||
    unbracketed.endsWith(".internal")
  )
    return true;
  if (isIPv4(unbracketed)) return isBlockedIpv4(unbracketed);
  if (/^\d+(?:\.\d+){0,3}$/u.test(unbracketed)) return true;
  const mappedV4 = mappedIpv4FromIpv6(unbracketed);
  if (mappedV4 !== undefined) return isBlockedIpv4(mappedV4);
  if (isIPv6(unbracketed)) {
    return (
      unbracketed === "::" ||
      unbracketed === "::1" ||
      /^(?:0+:){7}0*[01]$/iu.test(unbracketed) ||
      /^(?:fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}|fe[c-f][0-9a-f]|ff[0-9a-f]{2}):/iu.test(
        unbracketed,
      ) ||
      /^2001:0?db8(?::|$)/iu.test(unbracketed)
    );
  }
  return unbracketed.includes(":");
}

/** Validate an outbound HTTP(S) URL against scheme, private/link-local IP, and optional host allow-list rules. */
export function validateOutboundHttpUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return undefined;
  if (rawUrl.includes("\\")) return undefined;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const allowHttp = options.allowHttp ?? true;
  if (url.protocol !== "https:" && (!allowHttp || url.protocol !== "http:"))
    return undefined;
  if (url.username !== "" || url.password !== "" || url.hash !== "")
    return undefined;
  if (isBlockedOutboundHost(url.hostname)) return undefined;
  if (options.allowedHosts !== undefined) {
    const allowed =
      options.allowedHosts instanceof Set
        ? options.allowedHosts
        : new Set(options.allowedHosts);
    if (!allowed.has(url.hostname.toLowerCase())) return undefined;
  }
  return url.href;
}

/** Map a request URL or pathname to a fixed npm registry URL, or undefined if unsafe. */
export function npmRegistryUrl(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl.length === 0)
    return undefined;
  let pathname = requestUrl;
  if (!requestUrl.startsWith("/")) {
    if (/(?:^|\/)\.\.(?:\/|$)/u.test(requestUrl)) return undefined;
    const validated = validateOutboundHttpUrl(requestUrl, {
      allowedHosts: ALLOWED_UPSTREAM_HOSTS,
      allowHttp: false,
    });
    if (validated === undefined) return undefined;
    const parsed = new URL(validated);
    if (parsed.port !== "" || parsed.search !== "") return undefined;
    pathname = parsed.pathname;
  } else if (
    requestUrl.startsWith("//") ||
    requestUrl.includes("?") ||
    requestUrl.includes("#") ||
    requestUrl.includes("\\")
  ) {
    return undefined;
  }
  let segments;
  try {
    segments = pathname
      .slice(1)
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  if (!isValidRegistrySegments(segments)) return undefined;
  const candidate = `${NPM_REGISTRY_ORIGIN}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  return validateOutboundHttpUrl(candidate, {
    allowedHosts: ALLOWED_UPSTREAM_HOSTS,
    allowHttp: false,
  });
}

/** Exercise the packaged updater with real npm and a local release registry fixture. */
export async function verifyPackageUpdate({
  prefix,
  packageRoot,
  tarball,
  workspace,
  environment,
  commands,
}) {
  const metadataPath = join(packageRoot, "package.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const archive = await readFile(tarball);
  const entry = join(packageRoot, "scripts", "rea.mjs");
  const home = join(workspace, "update-home");
  const codexPath = join(home, ".codex", "config.toml");
  const originalConfig =
    '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@0.0.0", "mcp"]\n';
  await mkdir(dirname(codexPath), { recursive: true });
  await writeFile(codexPath, originalConfig);
  let fixtureFailure;
  const fixture = new AbortController();
  const server = createServer((request, response) => {
    void serveRegistry(request, response).catch((error) => {
      fixtureFailure ??= { cause: error };
      fixture.abort(fixtureFailure.cause);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500);
      response.end(String(error));
    });
  });
  let registry;
  async function serveRegistry(request, response) {
    const pathname = new URL(request.url, registry).pathname;
    if (pathname === "/rea-agents") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          name: metadata.name,
          "dist-tags": { latest: metadata.version },
          versions: {
            [metadata.version]: {
              ...metadata,
              dist: {
                tarball: `${registry}/release.tgz`,
                integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
              },
            },
          },
        }),
      );
    } else if (pathname === "/release.tgz") {
      response.end(archive);
    } else if (request.method === "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
    } else {
      const upstreamUrl = npmRegistryUrl(pathname);
      if (upstreamUrl === undefined) {
        response.writeHead(400).end();
        return;
      }
      const upstream = await fetch(upstreamUrl, { redirect: "error" });
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
      });
      response.end(body);
    }
  }
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return withVerifierCleanup(async () => {
    try {
      const address = server.address();
      if (typeof address !== "object" || address === null)
        throw new Error("Registry fixture did not bind");
      registry = `http://127.0.0.1:${address.port}`;
      // Model an older installed release's identity while retaining the new updater
      // under test. The registry supplies the unmodified packed target artifact.
      const generatedPath = join(
        packageRoot,
        "dist",
        "generatedPackageMetadata.js",
      );
      const generated = await readFile(generatedPath, "utf8");
      const previousVersion = "0.0.0";
      const previousGenerated = generated.replace(
        `version: "${metadata.version}"`,
        `version: "${previousVersion}"`,
      );
      if (previousGenerated === generated)
        throw new Error("Could not create previous-release identity fixture");
      await writeFile(generatedPath, previousGenerated);
      await writeFile(
        metadataPath,
        JSON.stringify({ ...metadata, version: previousVersion }),
      );
      const runtimeEnvironment = {
        ...environment,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        CLAUDE_CONFIG_DIR: home,
        CODEX_HOME: join(home, ".codex"),
        COPILOT_HOME: join(home, ".copilot"),
        GROK_HOME: join(home, ".grok"),
        SAND_DATA_ROOT: join(home, ".grokbot"),
        OMP_PROFILE: undefined,
        PI_CODING_AGENT_DIR: undefined,
        PI_CONFIG_DIR: undefined,
        PI_PROFILE: undefined,
        XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.json"),
        npm_config_prefix: prefix,
        npm_config_registry: registry,
      };
      const previous = (
        await commands.exec(process.execPath, [entry, "--version"], {
          env: runtimeEnvironment,
        })
      ).stdout.trim();
      if (previous !== previousVersion)
        throw new Error(`Previous-release fixture reported ${previous}`);
      const harness = join(workspace, "verify-update.mjs");
      await writeFile(
        harness,
        `
import { runUpdate } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/application/Update.js")).href)};
import { systemUpdateHost } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/application/UpdateRuntime.js")).href)};
const host = systemUpdateHost(${JSON.stringify(packageRoot)}, ${JSON.stringify(home)});
const result = await runUpdate(${JSON.stringify(previousVersion)}, host, "structured");
process.stdout.write(JSON.stringify(result));
if (result.status === "failed") process.exitCode = 1;
`,
      );
      const result = JSON.parse(
        (
          await commands.exec(process.execPath, [harness], {
            env: runtimeEnvironment,
            cwd: workspace,
            signal: fixture.signal,
            diagnosticBytes: 16 * 1024 * 1024,
          })
        ).stdout,
      );
      if (
        result.status !== "updated" ||
        result.installedVersion !== metadata.version ||
        result.command.at(-1) !== `${metadata.name}@${metadata.version}` ||
        result.maintenance.status !== "planned" ||
        result.maintenance.scope.clients.join(",") !== "codex" ||
        result.maintenance.scope.skill !== false
      )
        throw new Error(
          `Packaged updater failed its exact-release contract: ${JSON.stringify(result)}`,
        );
      if ((await readFile(codexPath, "utf8")) !== originalConfig)
        throw new Error(
          "Update applied integration maintenance without approval",
        );
      const current = (
        await commands.exec(process.execPath, [entry, "--version"], {
          env: runtimeEnvironment,
        })
      ).stdout.trim();
      if (current !== metadata.version)
        throw new Error(`Updated executable reported ${current}`);
      const help = (
        await commands.exec(process.execPath, [entry, "--help"], {
          env: runtimeEnvironment,
        })
      ).stdout;
      if (!/^\s{2}update\s/mu.test(help) || /^\s{2}upgrade\s/mu.test(help))
        throw new Error(
          "Updated CLI did not expose update as its sole maintenance command",
        );
      if (fixtureFailure !== undefined) throw fixtureFailure.cause;
      return {
        installed_version: result.installedVersion,
        exact_release: true,
        maintenance_read_only: true,
      };
    } catch (error) {
      // The registry owns its failure; command cleanup remains with commands.
      throw fixtureFailure === undefined ? error : fixtureFailure.cause;
    }
  }, [
    async () => {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) =>
        server.close((error) =>
          error === undefined ? resolveClose() : reject(error),
        ),
      );
    },
  ]);
}
