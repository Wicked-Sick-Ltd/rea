import type { PackageVerifierCommands } from "./lib/package-command-owner.mjs";

export function isBlockedOutboundHost(hostname: unknown): boolean;

export function validateOutboundHttpUrl(
  rawUrl: unknown,
  options?: {
    readonly allowedHosts?: ReadonlySet<string> | readonly string[];
    readonly allowHttp?: boolean;
  },
): string | undefined;

export function npmRegistryUrl(requestUrl: unknown): string | undefined;

export function verifyPackageUpdate(input: {
  readonly prefix: string;
  readonly packageRoot: string;
  readonly tarball: string;
  readonly workspace: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly commands: PackageVerifierCommands;
}): Promise<{
  readonly installed_version: string;
  readonly exact_release: boolean;
  readonly maintenance_read_only: boolean;
}>;
