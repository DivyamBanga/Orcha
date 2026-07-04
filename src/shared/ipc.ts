// Single source of truth for IPC channel names.
export const IPC = {
  // invoke: renderer -> main
  ProjectsAdd: 'projects:add',
  ProjectsList: 'projects:list',
  WorkspacesCreate: 'workspaces:create',
  WorkspacesList: 'workspaces:list',
  WorkspacesArchive: 'workspaces:archive',
  WorkspacesUpdateSettings: 'workspaces:updateSettings',
  SessionSend: 'session:send',
  SessionInterrupt: 'session:interrupt',
  SessionHistory: 'session:history',
  GitStatus: 'git:status',
  GitCommitPush: 'git:commitPush',
  GitCreatePr: 'git:createPr',
  PtyCreate: 'pty:create',
  PtyInput: 'pty:input',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  OrchestratorSend: 'orchestrator:send',
  OrchestratorInterrupt: 'orchestrator:interrupt',
  OrchestratorHistory: 'orchestrator:history',

  // events: main -> renderer
  EvSessionMessage: 'ev:session:message',
  EvSessionStatus: 'ev:session:status',
  EvPtyData: 'ev:pty:data',
  EvPtyExit: 'ev:pty:exit',
  EvGitStatus: 'ev:git:status',
  EvWorkspacesChanged: 'ev:workspaces:changed'
} as const
