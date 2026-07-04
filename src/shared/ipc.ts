// Single source of truth for IPC channel names.
export const IPC = {
  // invoke: renderer -> main
  ProjectsAdd: 'projects:add',
  ProjectsList: 'projects:list',
  ProjectsCreateRepo: 'projects:createRepo',
  ProjectsListGithub: 'projects:listGithub',
  ProjectsCloneGithub: 'projects:cloneGithub',
  SetupStatus: 'setup:status',
  WorkspacesCreate: 'workspaces:create',
  WorkspacesList: 'workspaces:list',
  WorkspacesArchive: 'workspaces:archive',
  SessionSend: 'session:send',
  GitStatus: 'git:status',
  GitCommitPush: 'git:commitPush',
  GitCreatePr: 'git:createPr',
  GitPull: 'git:pull',
  GitOpenGithub: 'git:openGithub',
  ShellOpenPath: 'shell:openPath',
  ProjectsRemove: 'projects:remove',
  PtyCreate: 'pty:create',
  PtyInput: 'pty:input',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  PtyRestart: 'pty:restart',
  OrchestratorSend: 'orchestrator:send',
  OrchestratorInterrupt: 'orchestrator:interrupt',
  OrchestratorHistory: 'orchestrator:history',

  UiGetState: 'ui:getState',
  UiSaveState: 'ui:saveState',

  // events: main -> renderer
  EvSessionMessage: 'ev:session:message',
  EvSessionStatus: 'ev:session:status',
  EvActivity: 'ev:activity',
  EvFocusSession: 'ev:focusSession',
  EvPtyData: 'ev:pty:data',
  EvPtyExit: 'ev:pty:exit',
  EvGitStatus: 'ev:git:status',
  EvWorkspacesChanged: 'ev:workspaces:changed'
} as const
