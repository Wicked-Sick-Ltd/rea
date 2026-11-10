/** Read the current file at `path` through one descriptor, then close it. */
export function readOpenedFile(path: string): Promise<{
  readonly mode: number;
  readonly bytes: Buffer;
}>;
