import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);

it("compiles only the bounded safe search subset", async () => {
  const javacName = process.platform === "win32" ? "javac.exe" : "javac";
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  const javac = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", javacName)
    : javacName;
  const java = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", javaName)
    : javaName;
  const root = resolve(".");
  const output = await mkdtemp(join(tmpdir(), "rea-ghidra-search-pattern-"));
  try {
    const compiled = await execute(
      javac,
      [
        "-d",
        output,
        join(root, "bridge/ghidra/ReaGhidraSearchPattern.java"),
        join(root, "tests/ghidra/ReaGhidraSearchPatternTest.java"),
      ],
      { cwd: root },
    );
    expect(compiled.stderr ?? "").toBe("");
    const ran = await execute(java, ["-cp", output, "ReaGhidraSearchPatternTest"], {
      cwd: root,
    });
    expect(ran.stdout).toBe("ok\n");
    expect(ran.stderr ?? "").toBe("");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
