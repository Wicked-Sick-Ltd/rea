import assert from "node:assert/strict";
import { chmod, open } from "node:fs/promises";
import { relative, sep } from "node:path";

import { parseArtifactInventoryEvidence } from "../../../dist/domain/artifactInventoryEvidence.js";
import {
  artifactCliEvidence,
  artifactMcpCall,
  withArtifactMcp,
} from "../../lib/artifact-e2e.mjs";

/** Read this descriptor from offset 0. A later readFile() would start at EOF. */
const readOpenedFile = async (handle) => {
  const { size } = await handle.stat();
  const buffer = Buffer.alloc(size);
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
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
};

const verifyOpenedMachOOccurrences = async (app, executable, handle) => {
  const originalMode = (await handle.stat()).mode & 0o7777;
  const originalBytes = await readOpenedFile(handle);
  const logicalPath = relative(app, executable).split(sep).join("/");
  const observations = [];
  try {
    for (const mode of [0o755, 0o644]) {
      await chmod(executable, mode);
      const directEvidence = await artifactCliEvidence(
        "inspect-artifact",
        executable,
      );
      const direct = parseArtifactInventoryEvidence(directEvidence).inventory;
      const containedEvidence = await artifactCliEvidence(
        "inspect-artifact",
        app,
      );
      const contained =
        parseArtifactInventoryEvidence(containedEvidence).inventory;
      assert.equal(direct.complete, true);
      assert.equal(contained.complete, true);
      const root = direct.occurrences.find(
        ({ logical_path }) => logical_path === ".",
      );
      const nested = contained.occurrences.find(
        ({ logical_path }) => logical_path === logicalPath,
      );
      assert.ok(root);
      assert.ok(nested);
      assert.ok(["mach-o", "mach-o-universal"].includes(root.artifact_format));
      for (const occurrence of [root, nested]) {
        assert.equal(occurrence.artifact_kind, "executable");
        assert.equal(occurrence.artifact_format, direct.manifest.root_format);
        assert.equal(occurrence.executable, mode === 0o755);
      }
      assert.equal(root.artifact_id, nested.artifact_id);
      assert.equal(root.artifact_id, direct.manifest.root_artifact_id);
      const node = contained.nodes.find(
        ({ artifact_id }) => artifact_id === nested.artifact_id,
      );
      assert.ok(node);
      assert.equal(node.sha256, direct.manifest.root_sha256);
      assert.equal(node.format, root.artifact_format);
      await withArtifactMcp(app, async (client) => {
        const reply = await artifactMcpCall(client, {
          name: "inspect_artifact",
          arguments: {},
        });
        assert.notEqual(reply.isError, true, JSON.stringify(reply));
        assert.deepEqual(
          parseArtifactInventoryEvidence(reply.structuredContent).inventory,
          contained,
        );
      });
      observations.push({
        mode: mode.toString(8),
        artifact_id: root.artifact_id,
        artifact_kind: root.artifact_kind,
        artifact_format: root.artifact_format,
        executable: root.executable,
        contained_cli_mcp_parity: true,
      });
    }
    assert.equal(observations[0].artifact_id, observations[1].artifact_id);
    assert.deepEqual(await readOpenedFile(handle), originalBytes);
    return {
      direct_cli: true,
      contained_cli_mcp: true,
      bytes_unchanged: true,
      observations,
    };
  } finally {
    await chmod(executable, originalMode);
  }
};

/** Verify native file roles and permissions on the real compiled bundle fixture. */
export async function verifyMachOOccurrences(app, executable) {
  const handle = await open(executable, "r");
  try {
    return await verifyOpenedMachOOccurrences(app, executable, handle);
  } finally {
    await handle.close();
  }
}
