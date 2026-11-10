import fs from "node:fs";
import { appendFile, chmod, open, rename, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { expect, it } from "vitest";

import { readOpenedFile } from "../../../scripts/lib/read-opened-file.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reads a replaced path through a new descriptor", async () => {
  const root = await createTestTempDirectory("rea-opened-file-");
  const path = join(root, "executable");
  const first = Buffer.from("original-bytes");
  const next = Buffer.from("replaced-bytes");
  await writeFile(path, first);
  await chmod(path, 0o755);

  const opened = await readOpenedFile(path);
  if (process.platform !== "win32") expect(opened.mode).toBe(0o755);
  expect(opened.bytes.equals(first)).toBe(true);

  const held = await open(path, "r");
  try {
    await writeFile(join(root, "next"), next);
    await rename(join(root, "next"), path);
    const reread = await readOpenedFile(path);
    expect(reread.bytes.equals(next)).toBe(true);
    const stale = Buffer.alloc(first.length);
    await held.read(stale, 0, stale.length, 0);
    expect(stale.equals(first)).toBe(true);
  } finally {
    await held.close();
  }
});

it("includes bytes appended after the descriptor is stat'd", async () => {
  const root = await createTestTempDirectory("rea-opened-file-append-");
  const path = join(root, "executable");
  const first = Buffer.from("original");
  const suffix = Buffer.from("-suffix");
  await writeFile(path, first);
  const originalOpen = fs.promises.open.bind(fs.promises);
  fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
    const opened = await originalOpen(...args);
    if (args[0] !== path) return opened;
    const stat = opened.stat.bind(opened);
    opened.stat = (async (options) => {
      const metadata = await stat(options);
      await appendFile(path, suffix);
      return metadata;
    }) as typeof opened.stat;
    return opened;
  };
  syncBuiltinESMExports();
  try {
    const opened = await readOpenedFile(path);
    expect(opened.bytes.equals(Buffer.concat([first, suffix]))).toBe(true);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});
