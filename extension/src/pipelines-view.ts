/**
 * Pipelines sidebar tree view.
 *
 * Renders grouped pipeline actions:
 *   Specs   → import, reverse, gap
 *   Tests   → quality, functional (validate), drift, generate
 *   Security→ deps, sast, owasp, generate
 *   Docs    → trace (matrix), generate
 *
 * Each leaf item fires a VS Code command when clicked.
 * The "Functional (validate)" item is collapsible with sub-options.
 */
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------

interface PipelineAction {
  label: string;
  description?: string;
  icon: string;
  command: string;
  contextValue?: string;
  children?: PipelineAction[];
}

interface PipelineGroup {
  label: string;
  icon: string;
  actions: PipelineAction[];
}

const PIPELINE_GROUPS: PipelineGroup[] = [
  {
    label: 'Specs',
    icon: 'book',
    actions: [
      {
        label: 'Import Spec',
        description: 'import from PRD/docs',
        icon: 'arrow-down',
        command: 'specguard.importSpec',
      },
      {
        label: 'Reverse Generate',
        description: 'generate specs from code',
        icon: 'wand',
        command: 'specguard.reverseGenerate',
      },
      {
        label: 'Gap Analysis',
        description: 'find unimplemented specs',
        icon: 'search',
        command: 'specguard.gapAnalysis',
      },
    ],
  },
  {
    label: 'Tests',
    icon: 'beaker',
    actions: [
      {
        label: 'Quality Check',
        description: 'lint & coverage quality',
        icon: 'verified',
        command: 'specguard.qualityCheck',
      },
      {
        label: 'Functional (validate)',
        description: 'run spec-driven tests',
        icon: 'run-all',
        command: 'specguard.validateFunctional',
        children: [
          {
            label: 'All tests',
            description: 'validate --all',
            icon: 'run-all',
            command: 'specguard.validateFunctionalAll',
            contextValue: 'pipeline-action',
          },
          {
            label: 'Integration tests',
            description: 'validate --type integration',
            icon: 'layers',
            command: 'specguard.validateFunctionalIntegration',
            contextValue: 'pipeline-action',
          },
          {
            label: 'E2E tests',
            description: 'validate --type e2e',
            icon: 'browser',
            command: 'specguard.validateFunctionalE2E',
            contextValue: 'pipeline-action',
          },
        ],
      },
      {
        label: 'Code Drift',
        description: 'detect spec ↔ code drift',
        icon: 'warning',
        command: 'specguard.drift',
      },
      {
        label: 'Generate Tests',
        description: 'generate from specs',
        icon: 'beaker',
        command: 'specguard.generateTests',
      },
    ],
  },
  {
    label: 'Security',
    icon: 'shield',
    actions: [
      {
        label: 'Dependency Audit',
        description: 'check for vulnerable deps',
        icon: 'package',
        command: 'specguard.depsAudit',
      },
      {
        label: 'SAST Scan',
        description: 'static analysis',
        icon: 'bug',
        command: 'specguard.runSast',
      },
      {
        label: 'OWASP Analysis',
        description: 'security --all',
        icon: 'shield',
        command: 'specguard.securityScan',
      },
      {
        label: 'Generate Security Tests',
        description: 'generate from security specs',
        icon: 'beaker',
        command: 'specguard.generateSecurityTests',
      },
    ],
  },
  {
    label: 'Docs',
    icon: 'file-text',
    actions: [
      {
        label: 'Traceability Matrix',
        description: 'spec → code → test trace',
        icon: 'list-tree',
        command: 'specguard.matrix',
      },
      {
        label: 'Generate Docs',
        description: 'generate user-facing docs',
        icon: 'file-text',
        command: 'specguard.generateDocs',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

class PipelineTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly data: PipelineAction | PipelineGroup,
    isGroup: boolean,
  ) {
    super(label, collapsibleState);
    const iconName = 'icon' in data ? data.icon : '';
    if (iconName) {
      this.iconPath = new vscode.ThemeIcon(iconName);
    }
    if (!isGroup && 'command' in data && data.command && !('actions' in data)) {
      const action = data as PipelineAction;
      this.command = {
        command: action.command,
        title: label,
        arguments: [],
      };
      this.tooltip = action.description ?? label;
      this.description = action.description;
      this.contextValue = action.contextValue ?? 'pipeline-action';
    } else if (isGroup) {
      this.contextValue = 'pipeline-group';
    } else if ('children' in data && (data as PipelineAction).children) {
      this.contextValue = 'pipeline-action-expandable';
      this.tooltip = (data as PipelineAction).description ?? label;
      this.description = (data as PipelineAction).description;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class PipelinesProvider implements vscode.TreeDataProvider<PipelineTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PipelineTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PipelineTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PipelineTreeItem): PipelineTreeItem[] {
    // Root: pipeline groups
    if (!element) {
      return PIPELINE_GROUPS.map((group) =>
        new PipelineTreeItem(
          group.label,
          vscode.TreeItemCollapsibleState.Collapsed,
          group,
          true,
        ),
      );
    }

    // Group children: pipeline actions
    if ('actions' in element.data) {
      const group = element.data as PipelineGroup;
      return group.actions.map((action) => {
        const hasChildren = action.children && action.children.length > 0;
        return new PipelineTreeItem(
          action.label,
          hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          action,
          false,
        );
      });
    }

    // Expandable action children (e.g. validate sub-options)
    if ('children' in element.data && (element.data as PipelineAction).children) {
      const action = element.data as PipelineAction;
      return (action.children ?? []).map((child) =>
        new PipelineTreeItem(
          child.label,
          vscode.TreeItemCollapsibleState.None,
          child,
          false,
        ),
      );
    }

    return [];
  }
}
