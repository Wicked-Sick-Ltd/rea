import { open } from "node:fs/promises";

/** Read the current file at `path` through one descriptor, then close it. */
export async function readOpenedFile(path) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      mode: metadata.mode & 0o7777,
      bytes: offset === buffer.length ? buffer : buffer.subarray(0, offset),
    };
  } finally {
    await handle.close();
  }
}
