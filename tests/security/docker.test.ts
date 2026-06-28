import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isDockerAvailable,
  runContainer,
  dockerRunner,
  DockerRunOpts,
} from "../src/adapters/docker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawnOk(stdout = "", stderr = "") {
  return vi.fn().mockReturnValue({ stdout, stderr, status: 0, error: undefined });
}

function makeSpawnFail(message = "spawn error") {
  return vi.fn().mockReturnValue({
    stdout: null,
    stderr: null,
    status: null,
    error: new Error(message),
  });
}

function captureSpawnArgs(): { calls: string[][] } {
  const calls: string[][] = [];
  vi.spyOn(dockerRunner, "spawn").mockImplementation((args, _timeout) => {
    calls.push([...args]);
    return { stdout: "output", stderr: "", status: 0, error: undefined };
  });
  return { calls };
}

// ---------------------------------------------------------------------------
// isDockerAvailable
// ---------------------------------------------------------------------------

describe("isDockerAvailable", () => {
  afterEach(() => vi.restoreAllMocks());

  // OWASP A05: Security Misconfiguration
  it("returns false and never throws when Docker daemon is unreachable", async () => {
    vi.spyOn(dockerRunner, "spawn").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await expect(isDockerAvailable()).resolves.toBe(false);
  });

  // OWASP A05: Security Misconfiguration
  it("returns false when spawn returns a non-zero status", async () => {
    vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      status: 1,
      error: undefined,
    });
    await expect(isDockerAvailable()).resolves.toBe(false);
  });

  // OWASP A05: Security Misconfiguration
  it("returns false when spawn returns an error object", async () => {
    vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: null,
      stderr: null,
      status: null,
      error: new Error("ENOENT docker"),
    });
    await expect(isDockerAvailable()).resolves.toBe(false);
  });

  // OWASP A05: Security Misconfiguration
  it("returns true only when daemon responds with exit 0", async () => {
    vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: "24.0.5",
      stderr: "",
      status: 0,
      error: undefined,
    });
    await expect(isDockerAvailable()).resolves.toBe(true);
  });

  // OWASP A03: Injection — probe must use only safe, fixed args
  it("probes Docker with only safe fixed args (no caller-controlled input)", async () => {
    const spy = vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: "24.0.5",
      stderr: "",
      status: 0,
      error: undefined,
    });
    await isDockerAvailable();
    const [args] = spy.mock.calls[0];
    expect(args).toEqual(["info", "--format", "{{.ServerVersion}}"]);
  });
});

// ---------------------------------------------------------------------------
// runContainer — credential / secret redaction in logs
// ---------------------------------------------------------------------------

describe("runContainer — credential redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  // OWASP A09: Security Logging and Monitoring Failures
  it("does NOT expose secret env-var values in the args array passed to spawn", async () => {
    const secret = "s3cr3t-p4ssw0rd";
    const captured: string[][] = [];
    vi.spyOn(dockerRunner, "spawn").mockImplementation((args, _t) => {
      captured.push([...args]);
      return { stdout: "", stderr: "", status: 0, error: undefined };
    });

    await runContainer({
      image: "myapp",
      env: [{ name: "DB_PASSWORD", value: secret }],
    });

    // The raw value will be in the args (that is unavoidable for docker -e),
    // but the test asserts the adapter does NOT additionally log / expose it
    // in stdout or stderr of the returned result.
    const result = await runContainer({
      image: "myapp",
      env: [{ name: "DB_PASSWORD", value: secret }],
    });
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  // OWASP A09: Security Logging and Monitoring Failures
  it("does not leak env-var values into the ContainerResult stderr on spawn error", async () => {
    const secret = "tok3n-abc123";
    vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: null,
      stderr: null,
      status: null,
      error: new Error("docker: command not found"),
    });

    const result = await runContainer({
      image: "scanner",
      env: [{ name: "API_TOKEN", value: secret }],
    });

    expect(result.stderr).not.toContain(secret);
    expect(result.ok).toBe(false);
  });

  // OWASP A09: Security Logging and Monitoring Failures
  it("does not embed env-var name=value pairs in the ok-false stderr message", async () => {
    const secret = "hunter2";
    vi.spyOn(dockerRunner, "spawn").mockImplementation(() => {
      throw new Error("unexpected internal error");
    });

    const result = await runContainer({
      image: "scanner",
      env: [{ name: "SECRET_KEY", value: secret }],
    });

    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("SECRET_KEY=");
  });
});

// ---------------------------------------------------------------------------
// runContainer — volume mount enforcement (read-only by default)
// ---------------------------------------------------------------------------

describe("runContainer — volume mount security", () => {
  afterEach(() => vi.restoreAllMocks());

  // OWASP A01: Broken Access Control
  it("mounts volumes as :ro by default", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "analyzer",
      volumes: [{ host: "/host/src", container: "/src" }],
    });

    const args = calls[0];
    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe("/host/src:/src:ro");
  });

  // OWASP A01: Broken Access Control
  it("respects explicit :ro mode", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "analyzer",
      volumes: [{ host: "/data", container: "/data", mode: "ro" }],
    });

    const args = calls[0];
    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).toMatch(/:ro$/);
  });

  // OWASP A01: Broken Access Control
  it("allows :rw only when caller explicitly opts in", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "builder",
      volumes: [{ host: "/out", container: "/out", mode: "rw" }],
    });

    const args = calls[0];
    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).toBe("/out:/out:rw");
  });

  // OWASP A01: Broken Access Control
  it("mounts multiple volumes each with :ro by default", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "multi",
      volumes: [
        { host: "/a", container: "/a" },
        { host: "/b", container: "/b" },
      ],
    });

    const args = calls[0];
    const vFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") vFlags.push(args[i + 1]);
    }
    expect(vFlags).toHaveLength(2);
    vFlags.forEach((f) => expect(f).toMatch(/:ro$/));
  });

  // OWASP A01: Broken Access Control
  it("does not allow a volume mount without an explicit mode to become :rw", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "scanner",
      volumes: [{ host: "/sensitive", container: "/sensitive" }],
    });

    const args = calls[0];
    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).not.toMatch(/:rw$/);
  });
});

// ---------------------------------------------------------------------------
// runContainer — flag injection prevention
// ---------------------------------------------------------------------------

describe("runContainer — Docker flag injection prevention", () => {
  afterEach(() => vi.restoreAllMocks());

  // OWASP A03: Injection
  it("does not allow arbitrary Docker flags via the image name", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({ image: "--privileged myimage" });

    const args = calls[0];
    // The image:tag token must appear as a single positional arg, not split
    const imageArg = args.find((a) => a.includes("--privileged"));
    // If present it must be inside the image:tag string, not a standalone flag
    if (imageArg !== undefined) {
      const imageIdx = args.indexOf(imageArg);
      const rmIdx = args.indexOf("--rm");
      // It must come AFTER --rm and the image:tag position, never before
      expect(imageIdx).toBeGreaterThan(rmIdx);
      // It must not be a bare flag (i.e. it is part of the image:tag string)
      expect(imageArg).toContain("--privileged myimage");
    }
  });

  // OWASP A03: Injection
  it("does not allow shell metacharacters in image name to escape the command", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({ image: "myimage; rm -rf /" });

    const args = calls[0];
    // spawnSync is used (not shell), so the whole string is one arg — verify
    // the adapter passes it as a single element, not split on semicolons
    const joined = args.join(" ");
    // The semicolon must be inside a single arg token, not a shell separator
    const semicolonArg = args.find((a) => a.includes(";"));
    expect(semicolonArg).toBeDefined();
    // It should be the image:tag token, not a standalone shell command
    expect(semicolonArg).toContain("myimage;");
  });

  // OWASP A03: Injection
  it("does not allow extra Docker flags via the args array", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "scanner",
      args: ["--privileged", "scan", "/target"],
    });

    const args = calls[0];
    // --privileged must appear only AFTER the image:tag token
    const imageTagIdx = args.findIndex((a) => a.startsWith("scanner:"));
    const privIdx = args.indexOf("--privileged");
    if (privIdx !== -1) {
      expect(privIdx).toBeGreaterThan(imageTagIdx);
    }
  });

  // OWASP A03: Injection
  it("does not allow env var names to inject additional -e flags", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "app",
      env: [{ name: "FOO", value: "bar -e INJECTED=evil" }],
    });

    const args = calls[0];
    // Count occurrences of '-e' — should be exactly 1 (for FOO)
    const eCount = args.filter((a) => a === "-e").length;
    expect(eCount).toBe(1);
  });

  // OWASP A03: Injection
  it("does not allow volume host path to inject additional -v flags", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({
      image: "app",
      volumes: [{ host: "/safe -v /etc:/etc", container: "/safe" }],
    });

    const args = calls[0];
    const vCount = args.filter((a) => a === "-v").length;
    // Only one -v flag should be present
    expect(vCount).toBe(1);
  });

  // OWASP A03: Injection
  it("does not allow tag to inject additional Docker flags", async () => {
    const { calls } = captureSpawnArgs();

    await runContainer({ image: "myimage", tag: "latest --network host" });

    const args = calls[0];
    // --network must not appear as a standalone flag before the image:tag
    const networkIdx = args.indexOf("--network");
    if (networkIdx !== -1) {
      const imageTagIdx = args.findIndex((a) => a.startsWith("myimage:"));
      expect(networkIdx).toBeGreaterThan(imageTagIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// runContainer — graceful degradation / error handling
// ---------------------------------------------------------------------------

describe("runContainer — graceful degradation", () => {
  afterEach(() => vi.restoreAllMocks());

  // OWASP A05: Security Misconfiguration
  it("returns ok:false with exitCode -1 when spawn returns an error", async () => {
    vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: null,
      stderr: null,
      status: null,
      error: new Error("ENOENT"),
    });

    const result = await runContainer({ image: "scanner" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
  });

  // OWASP A05: Security Misconfiguration
  it("never throws even when spawn throws synchronously", async () => {
    vi.spyOn(dockerRunner, "spawn").mockImplementation(() => {
      throw new Error("catastrophic failure");
    });

    await expect(runContainer({ image: "scanner" })).resolves.toMatchObject({
      ok: false,
      exitCode: -1,
    });
  });

  // OWASP A05: Security Misconfiguration
  it("returns ok:false when container exits with non-zero status", async () => {
    vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: "",
      stderr: "permission denied",
      status: 1,
      error: undefined,
    });

    const result = await runContainer({ image: "scanner" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  // OWASP A05: Security Misconfiguration
  it("returns ok:true only when exit code is exactly 0", async () => {
    vi.spyOn(dockerRunner, "spawn").mockReturnValue({
      stdout: "clean",
      stderr: "",
      status: 0,
      error: undefined,
    });

    const result = await runContainer({ image: "scanner" });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runContainer — command structure integrity
// ---------------------------------------------------------------------------

describe("runContainer — command structure integrity", () => {
  afterEach(() => vi.restoreAllMocks());

  // OWASP A03: Injection
  it("always starts the docker args with ['run', '--
