/**
 * MCP registration helper.
 *
 * Writes a `specguard-mcp` entry to the Cursor MCP config file
 * (`.cursor/mcp.json` in the workspace) or the VS Code MCP config when
 * running in a compatible environment.
 *
 * Called from the `specguard.registerMcp` command and on first activation
 * inside Cursor.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Register the specguard-mcp server in the Cursor MCP configuration file.
 * Supports both workspace-level (.cursor/mcp.json) and user-level locations.
 *
 * Idempotent — if the entry already exists, it is updated in place.
 */
export async function registerMcpForCursor(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!ws) {
    vscode.window.showWarningMessage('SpecGuard: No workspace folder open. Cannot register MCP.');
    return;
  }

  const mcpConfigPath = path.join(ws, '.cursor', 'mcp.json');
  const cursorDir = path.join(ws, '.cursor');

  // Ensure .cursor/ directory exists.
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  // Load existing config or start fresh.
  let config: McpConfig = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const raw = fs.readFileSync(mcpConfigPath, 'utf-8');
      config = JSON.parse(raw) as McpConfig;
    } catch {
      vscode.window.showWarningMessage(
        `SpecGuard: Could not parse ${mcpConfigPath}. Creating a new entry alongside existing content.`,
      );
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Resolve the specguard-mcp binary path.
  const localMcp = path.join(ws, 'node_modules', '.bin', 'specguard-mcp');
  const mcpCommand = fs.existsSync(localMcp) ? localMcp : 'npx';
  const mcpArgs = fs.existsSync(localMcp) ? [] : ['specguard-mcp'];

  // Write the entry.
  config.mcpServers['specguard-mcp'] = {
    command: mcpCommand,
    args: mcpArgs,
    env: {},
  };

  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  vscode.window.showInformationMessage(
    `SpecGuard MCP server registered in ${mcpConfigPath}. Restart Cursor to activate.`,
    'Open Config',
  ).then((action) => {
    if (action === 'Open Config') {
      void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mcpConfigPath));
    }
  });
}
