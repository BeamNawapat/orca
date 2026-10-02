import type { AppState } from '../../../types'

// Why: the workspace dot is a waiting tab's only sign outside its tab strip, so it must outlive siblings' acks (#24879).
export function hasUnreadSiblingTerminalTab(
  state: Pick<AppState, 'tabsByWorktree' | 'unreadTerminalTabs'>,
  worktreeId: string,
  exceptTabId?: string | null
): boolean {
  const tabs = state.tabsByWorktree[worktreeId]
  if (!tabs) {
    return false
  }
  return tabs.some((tab) => tab.id !== exceptTabId && Boolean(state.unreadTerminalTabs[tab.id]))
}
