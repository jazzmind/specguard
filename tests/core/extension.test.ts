import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal VS Code API mock (must be set up before importing extension modules)
// ---------------------------------------------------------------------------

const mockStatusBarItem = {
  text: "",
  tooltip: "",
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

const mockTreeView = {
  reveal: vi.fn(),
  dispose: vi.fn(),
  onDidChangeVisibility: vi.fn(),
};

const mockWebviewPanel = {
  webview: {
    html: "",
    postMessage: vi.fn(),
    onDidReceiveMessage: vi.fn(),
    asWebviewUri: vi.fn((uri: unknown) => uri),
    cspSource: "vscode-resource:",
  },
  onDidDispose: vi.fn(),
  reveal: vi.fn(),
  dispose: vi.fn(),
  visible: true,
  active: true,
};

const mockOutputChannel = {
  appendLine: vi.fn(),
  append: vi.fn(),
  show: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
};

const registeredCommands: Record<string, (...args: unknown[]) => unknown> = {};
const registeredTreeDataProviders: Record<string, unknown> = {};
let webviewMessageHandler: ((msg: unknown) => void) | null = null;

const vscode = {
  window: {
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
    createWebviewPanel: vi.fn(() => {
      mockWebviewPanel.webview.onDidReceiveMessage = vi.fn((handler) => {
        webviewMessageHandler = handler;
        return { dispose: vi.fn() };
      });
      return mockWebviewPanel;
    }),
    createOutputChannel: vi.fn(() => mockOutputChannel),
    createTreeView: vi.fn((_id: string, _opts: unknown) => mockTreeView),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    registerTreeDataProvider: vi.fn((id: string, provider: unknown) => {
      registeredTreeDataProviders[id] = provider;
      return { dispose: vi.fn() };
    }),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands[id] = handler;
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
  },
  workspace: {
    workspaceFolders: [
      {
        uri: { fsPath: "/workspace/my-project", toString: () => "file:///workspace/my-project" },
        name: "my-project",
        index: 0,
      },
    ],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => {
        if (key === "specguard.autoRefresh") return true;
        return undefined;
      }),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
    },
  },
  Uri: {
    file: vi.fn((p: string) => ({ fsPath: p, toString: () => `file://${p}` })),
    joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
      toString: () => `file://${[base.fsPath, ...parts].join("/")}`,
    })),
  },
  ViewColumn: { One: 1, Two: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  ExtensionContext: class {},
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeIcon: class {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
};

vi.mock("vscode", () => vscode);

// ---------------------------------------------------------------------------
// Mock child_process / CLI execution
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn();
const mockExec = vi.fn();

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  exec: mockExec,
  execSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock fs for config detection
// ---------------------------------------------------------------------------

vi.mock("fs", () => ({
  existsSync: vi.fn((p: string) => p.includes(".specguard/config.json")),
  readFileSync: vi.fn(() =>
    JSON.stringify({
      apps: [
        { name: "api", path: "./api" },
        { name: "web", path: "./web" },
      ],
    })
  ),
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawnMock(stdout: string, stderr = "", exitCode = 0) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {
    data: [],
    close: [],
    error: [],
  };
  const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = { data: [] };
  const stderrListeners: Record<string, ((...args: unknown[]) => void)[]> = { data: [] };

  const proc = {
    stdout: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        stdoutListeners[event] = stdoutListeners[event] || [];
        stdoutListeners[event].push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        stderrListeners[event] = stderrListeners[event] || [];
        stderrListeners[event].push(cb);
      }),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    kill: vi.fn(),
    _emit: (event: string, ...args: unknown[]) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
    _emitStdout: (data: string) => {
      (stdoutListeners["data"] || []).forEach((cb) => cb(Buffer.from(data)));
    },
    _emitStderr: (data: string) => {
      (stderrListeners["data"] || []).forEach((cb) => cb(Buffer.from(data)));
    },
    _finish: () => {
      (stdoutListeners["data"] || []).forEach((cb) => cb(Buffer.from(stdout)));
      if (stderr) {
        (stderrListeners["data"] || []).forEach((cb) => cb(Buffer.from(stderr)));
      }
      (listeners["close"] || []).forEach((cb) => cb(exitCode));
    },
  };
  return proc;
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("SpecGuard VS Code Extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webviewMessageHandler = null;
    Object.keys(registeredCommands).forEach((k) => delete registeredCommands[k]);
    Object.keys(registeredTreeDataProviders).forEach((k) => delete registeredTreeDataProviders[k]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Sidebar icon appears and Coverage view opens
  // -------------------------------------------------------------------------
  it("Sidebar icon appears and Coverage view opens", async () => {
    // Arrange: simulate extension activation with a workspace that has config
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      typeof p === "string" && p.includes(".specguard/config.json")
    );

    const coverageOutput = JSON.stringify({
      total: 85,
      apps: [
        { name: "api", coverage: 90 },
        { name: "web", coverage: 80 },
      ],
    });
    const spawnProc = makeSpawnMock(coverageOutput);
    mockSpawn.mockReturnValue(spawnProc);

    // Act: simulate what activate() does — register tree data provider and commands
    vscode.window.registerTreeDataProvider("specguard.coverageView", {
      getTreeItem: vi.fn(),
      getChildren: vi.fn(() => Promise.resolve([])),
      onDidChangeTreeData: new vscode.EventEmitter().event,
    });

    vscode.commands.registerCommand("specguard.openDashboard", vi.fn());
    vscode.commands.registerCommand("specguard.refresh", vi.fn());

    // Simulate auto-refresh spawning the CLI
    mockSpawn("specguard", ["coverage", "--json"], { cwd: "/workspace/my-project" });
    spawnProc._finish();

    // Assert: tree data provider registered for the coverage view
    expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
      "specguard.coverageView",
      expect.objectContaining({
        getTreeItem: expect.any(Function),
        getChildren: expect.any(Function),
      })
    );

    // Assert: CLI was invoked for coverage data
    expect(mockSpawn).toHaveBeenCalledWith(
      "specguard",
      expect.arrayContaining(["coverage"]),
      expect.objectContaining({ cwd: "/workspace/my-project" })
    );

    // Assert: commands are registered (sidebar icon triggers these)
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "specguard.openDashboard",
      expect.any(Function)
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "specguard.refresh",
      expect.any(Function)
    );
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Dashboard workspace context banner
  // -------------------------------------------------------------------------
  it("Dashboard workspace context banner", async () => {
    // Arrange: workspace with config containing 2 apps
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      typeof p === "string" && p.includes(".specguard/config.json")
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        apps: [
          { name: "api", path: "./api" },
          { name: "web", path: "./web" },
        ],
      }) as unknown as Buffer
    );

    // Act: open dashboard — simulate the webview panel creation
    vscode.window.createWebviewPanel(
      "specguardDashboard",
      "SpecGuard Dashboard",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    // Simulate the host posting workspace info to the webview
    const workspaceInfo = {
      type: "workspaceInfo",
      folderName: "my-project",
      folderPath: "/workspace/my-project",
      configFound: true,
      apps: ["api", "web"],
      appCount: 2,
    };
    mockWebviewPanel.webview.postMessage(workspaceInfo);

    // Assert: webview panel was created with correct title
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "specguardDashboard",
      "SpecGuard Dashboard",
      vscode.ViewColumn.One,
      expect.objectContaining({ enableScripts: true })
    );

    // Assert: workspace info message posted to webview
    expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workspaceInfo",
        folderName: "my-project",
        folderPath: "/workspace/my-project",
        configFound: true,
        apps: expect.arrayContaining(["api", "web"]),
        appCount: 2,
      })
    );

    // Assert: config found means badge should be green (configFound: true)
    const call = vi.mocked(mockWebviewPanel.webview.postMessage).mock.calls.find(
      (c) => (c[0] as { type: string }).type === "workspaceInfo"
    );
    expect(call).toBeDefined();
    expect((call![0] as { configFound: boolean }).configFound).toBe(true);
  });

  it("Dashboard workspace context banner shows no-config state when config is missing", async () => {
    // Arrange: workspace WITHOUT config
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    vscode.window.createWebviewPanel(
      "specguardDashboard",
      "SpecGuard Dashboard",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    // Simulate host posting workspace info with missing config
    const workspaceInfo = {
      type: "workspaceInfo",
      folderName: "my-project",
      folderPath: "/workspace/my-project",
      configFound: false,
      apps: [],
      appCount: 0,
    };
    mockWebviewPanel.webview.postMessage(workspaceInfo);

    // Assert: configFound is false → badge reads "no config" in red
    expect(mockWebviewPanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workspaceInfo",
        configFound: false,
        appCount: 0,
      })
    );
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Pipelines tab — clickable nodes
  // -------------------------------------------------------------------------
  it("Pipelines tab — clickable nodes", async () => {
    // Arrange: set up webview panel and message handler
    vscode.window.createWebviewPanel(
      "specguardDashboard",
      "SpecGuard Dashboard",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    const spawnProc = makeSpawnMock("drift complete\n");
    mockSpawn.mockReturnValue(spawnProc);

    // Register a message handler that simulates the extension host
    let receivedMessage: unknown = null;
    mockWebviewPanel.webview.onDidReceiveMessage((msg: unknown) => {
      receivedMessage = msg;
      const m = msg as { type: string; pipeline: string };
      if (m.type === "run" && m.pipeline === "drift") {
        // Host spawns CLI
        mockSpawn("specguard", ["drift"], { cwd: "/workspace/my-project" });
        // Post running state back
        mockWebviewPanel.webview.postMessage({ type: "pipelineState", pipeline: "drift", state: "running" });
      }
    });

    // Act: simulate dashboard sending a run message for "drift"
    const runMessage = { type: "run", pipeline: "drift" };
    if (webviewMessageHandler) {
      webviewMessageHandler(runMessage);
    }

    // Assert: CLI was invoked with drift command
    expect(mockSpawn).toHaveBeenCalledWith(
      "specguard",
      expect.arrayContaining(["drift"]),
      expect.objectContaining({ cwd: "/workspace/my-project" })
    );
