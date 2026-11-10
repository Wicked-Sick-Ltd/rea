import { open } from "node:fs/promises";

/** Read the current file at `path` through one descriptor, then close it. */
export async function readOpenedFile(path) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    // readFile follows this descriptor to EOF. A size taken before the read
    // would miss bytes appended to the same inode.
    return {
      mode: metadata.mode & 0o7777,
      bytes: await handle.readFile(),
    };
  } finally {
    await handle.close();
  }
}
