import { beforeEach, describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  present: true,
  reason: "process_not_in_snapshot",
}));
const execFileOutputMock = vi.hoisted(() =>
  vi.fn(async (_command: string, _arguments: readonly string[]) => ({
    stdout: source.present ? "100 1 100 501 S fixture" : "",
  })),
);
vi.mock("./ExecFileOutput.js", () => ({
  execFileOutput: execFileOutputMock,
}));
vi.mock("./DarwinProcessRunTokenReader.js", () => ({
  createDarwinProcessRunTokenReader: () => ({
    read: async () =>
      new Map([[100, { state: "unavailable", reason: source.reason }]]),
  }),
}));

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { createSystemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";
import { ProcessRunTokenReadError } from "./ProcessRunTokenObservations.js";

const enoentError = (command: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });

beforeEach(() => {
  execFileOutputMock.mockReset();
  execFileOutputMock.mockImplementation(async () => ({
    stdout: source.present ? "100 1 100 501 S fixture" : "",
  }));
});

it.each([
  { present: false, reason: "unused", availability: "absent" },
  { present: true, reason: "process_not_in_snapshot", availability: "absent" },
  { present: true, reason: "sysctl_failed_13", availability: "unavailable" },
])(
  "retains native run-token availability at the host adapter: %j",
  async (state) => {
    Object.assign(source, state);
    const host = createSystemProcessOwnershipHost("darwin", {});
    const failure = await host
      .environment(100)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProcessRunTokenReadError);
    expect(failure).toMatchObject({
      pid: 100,
      availability: state.availability,
      reason: state.present ? state.reason : "process_not_in_snapshot",
    });
  },
);

describe("system process ownership ps ENOENT fallbacks", () => {
  it("falls back to /usr/bin/ps and /bin/ps when ps is absent from PATH", async () => {
    execFileOutputMock.mockImplementation(async (command, arguments_) => {
      if (command === "ps" || command === "/usr/bin/ps")
        throw enoentError(command);
      if (arguments_[0] === "eww")
        return { stdout: "100 ?? S 0:00.01 fixture REA_PROCESS_RUN_ID=run-1" };
      return {
        stdout: `${String(process.pid)} ${String(process.ppid)} ${String(process.pid)} 501 S node`,
      };
    });

    const linuxHost = createSystemProcessOwnershipHost("linux", { PATH: "" });
    await expect(linuxHost.prepare?.()).resolves.toBeUndefined();
    await expect(linuxHost.listProcesses()).resolves.toEqual([
      {
        pid: process.pid,
        parentPid: process.ppid,
        processGroupId: process.pid,
        uid: 501,
        state: "S",
        command: "node",
      },
    ]);

    const freebsdHost = createSystemProcessOwnershipHost("freebsd", {
      PATH: "",
    });
    await expect(freebsdHost.environment(100)).resolves.toEqual({
      REA_PROCESS_RUN_ID: "run-1",
    });

    expect(execFileOutputMock.mock.calls.map(([command]) => command)).toEqual([
      "ps",
      "/usr/bin/ps",
      "/bin/ps",
      "ps",
      "/usr/bin/ps",
      "/bin/ps",
      "ps",
      "/usr/bin/ps",
      "/bin/ps",
    ]);
  });

  it("fails closed when ps and all fallback paths return ENOENT", async () => {
    execFileOutputMock.mockImplementation(async (command) => {
      throw enoentError(command);
    });

    const host = createSystemProcessOwnershipHost("linux", { PATH: "" });
    const failure = await host.prepare?.().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(failure).toMatchObject({
      providerId: "process-ownership",
      operation: "prepare_owned_process",
      reason: expect.stringContaining("spawn ps ENOENT"),
    });
    expect(execFileOutputMock.mock.calls.map(([command]) => command)).toEqual([
      "ps",
      "/usr/bin/ps",
      "/bin/ps",
    ]);
  });

  it("propagates non-ENOENT failures without consulting later ps fallbacks", async () => {
    const permissionDenied = Object.assign(
      new Error("spawn /usr/bin/ps EACCES"),
      { code: "EACCES" },
    );
    execFileOutputMock.mockImplementation(async (command) => {
      if (command === "ps") throw enoentError(command);
      throw permissionDenied;
    });

    const host = createSystemProcessOwnershipHost("linux", { PATH: "" });
    const failure = await host.prepare?.().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(failure).toMatchObject({
      providerId: "process-ownership",
      operation: "prepare_owned_process",
      reason: expect.stringContaining("spawn /usr/bin/ps EACCES"),
    });
    expect(execFileOutputMock.mock.calls.map(([command]) => command)).toEqual([
      "ps",
      "/usr/bin/ps",
    ]);
  });
});
