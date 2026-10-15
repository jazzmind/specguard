/**
 * Holds the extension's one connection to SpecGuard's API (a team server or a local `serve`), signs the user in, and
 * tells the views when it changes.
 */
import * as vscode from 'vscode';
import * as path from 'path';

import { resolveCliPath } from '../dashboard/cli.js';
import { connect, normalizeUrl, resolveServer, type Live } from './connection.js';

const SECRET_PREFIX = 'specguard.token:';

export class ApiHub implements vscode.Disposable {
  private live?: Promise<Live>;
  private liveRoot?: string;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('specguard.serverUrl') || e.affectsConfiguration('specguard.serverProject') || e.affectsConfiguration('specguard.serverMode')) this.reset();
    });
  }

  private settings() {
    const cfg = vscode.workspace.getConfiguration('specguard');
    const url = cfg.get<string>('serverUrl', '').trim();
    const project = cfg.get<string>('serverProject', '').trim();
    return { ...(url ? { url } : {}), ...(project ? { project } : {}), mode: cfg.get<'auto' | 'off'>('serverMode', 'auto') };
  }

  /** The connection for this workspace, made once and reused until settings or the sign-in change. */
  get(workspaceRoot: string): Promise<Live> {
    if (this.live && this.liveRoot === workspaceRoot) return this.live;
    this.reset(false);
    this.liveRoot = workspaceRoot;
    this.live = (async () => {
      const settings = this.settings();
      const known = resolveServer({ workspaceRoot, settings, resolveCli: async () => '' });
      const storedToken = known ? await this.secrets.get(SECRET_PREFIX + known.url) : undefined;
      return connect({
        workspaceRoot,
        settings,
        storedToken,
        resolveCli: () => resolveCliPath(workspaceRoot),
      });
    })();
    // A failed connection must not be remembered forever.
    this.live.catch(() => this.reset(false));
    return this.live;
  }

  /** Drop the connection (and a local server it started); the next `get` makes a new one. */
  reset(notify = true): void {
    const old = this.live;
    this.live = undefined;
    this.liveRoot = undefined;
    void old?.then((l) => l.dispose()).catch(() => undefined);
    if (notify) this.changed.fire();
  }

  /** What the status bar and the sidebar say about where data comes from. */
  async describe(workspaceRoot: string): Promise<{ source: 'server' | 'local'; label: string; notice?: string } | undefined> {
    try {
      const live = await this.get(workspaceRoot);
      return { source: live.source, label: live.source === 'server' ? `team server · ${live.project}` : 'local', ...(live.notice ? { notice: live.notice } : {}) };
    } catch {
      return undefined;
    }
  }

  async signIn(workspaceRoot: string): Promise<void> {
    const configured = resolveServer({ workspaceRoot, settings: this.settings(), resolveCli: async () => '' });
    const url = normalizeUrl(
      (await vscode.window.showInputBox({ title: 'SpecGuard team server', prompt: 'Address of the team server', value: configured?.url ?? '', placeHolder: 'http://ae1pocltv03/specguard', ignoreFocusOut: true })) ?? '',
    );
    if (!url) return;
    const token = await vscode.window.showInputBox({ title: 'SpecGuard token', prompt: `Create one on ${url}/ under Tokens, and paste it here`, password: true, ignoreFocusOut: true });
    if (!token) return;
    // A token that does not work must not be saved.
    try {
      const res = await fetch(`${url}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        void vscode.window.showErrorMessage(res.status === 401 ? 'The server did not accept that token.' : `The server answered ${res.status}; the token was not saved.`);
        return;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Cannot reach ${url} (${(err as Error).message}); the token was not saved.`);
      return;
    }
    await this.secrets.store(SECRET_PREFIX + url, token);
    if (!this.settings().url && !configured) await vscode.workspace.getConfiguration('specguard').update('serverUrl', url, vscode.ConfigurationTarget.Workspace);
    void vscode.window.showInformationMessage(`Signed in to ${url}${configured?.project ? ` as a reader of ${configured.project}` : ''}.`);
    this.reset();
  }

  async signOut(workspaceRoot: string): Promise<void> {
    const known = resolveServer({ workspaceRoot, settings: this.settings(), resolveCli: async () => '' });
    if (!known) return;
    await this.secrets.delete(SECRET_PREFIX + known.url);
    void vscode.window.showInformationMessage(`Forgot the token for ${known.url}.`);
    this.reset();
  }

  dispose(): void {
    this.subscription.dispose();
    this.reset(false);
    this.changed.dispose();
  }
}

export const projectNameOf = (workspaceRoot: string, live: Live): string => live.project ?? path.basename(workspaceRoot);
