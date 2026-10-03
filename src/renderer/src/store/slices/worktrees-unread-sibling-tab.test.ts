import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const mockApi = createStoreCascadesMockApi()

// #24879: a bell in tab 2 must keep the workspace dot while the user works in tab 1.
describe('workspace unread with a sibling tab still unread', () => {
  const wt = makeWorktree({
    id: 'repo1::/path/wt1',
    repoId: 'repo1',
    path: '/path/wt1',
    isUnread: true
  })
  const tab1 = makeTab({ id: 'tab-1', worktreeId: wt.id, sortOrder: 0 })
  const tab2 = makeTab({ id: 'tab-2', worktreeId: wt.id, sortOrder: 1 })

  function seed(activeTabId: string): ReturnType<typeof createTestStore> {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [wt] },
      tabsByWorktree: { [wt.id]: [tab1, tab2] },
      unifiedTabsByWorktree: {
        [wt.id]: [tab1, tab2].map((tab) =>
          makeUnifiedTab({ id: tab.id, worktreeId: wt.id, groupId: 'group-1' })
        )
      },
      groupsByWorktree: {
        [wt.id]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: wt.id,
            activeTabId,
            tabOrder: [tab1.id, tab2.id]
          })
        ]
      },
      activeGroupIdByWorktree: { [wt.id]: 'group-1' },
      unreadTerminalTabs: { [tab2.id]: 'terminal-bell' }
    })
    return store
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('keeps the dot when typing in another tab clears only that tab', () => {
    const store = seed(tab1.id)

    store.getState().clearTerminalTabUnread(tab1.id)
    store.getState().clearWorktreeUnread(wt.id)

    expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(true)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('clears the dot once the waiting tab is acknowledged too', () => {
    const store = seed(tab2.id)

    store.getState().clearTerminalTabUnread(tab2.id)
    store.getState().clearWorktreeUnread(wt.id)

    expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: wt.id, updates: { isUnread: false } })
    )
  })

  it('clears the dot when the waiting tab is picked from the tab strip', () => {
    const store = seed(tab1.id)
    store.getState().setActiveWorktree(wt.id)

    store.getState().activateTab(tab2.id)

    expect(store.getState().unreadTerminalTabs[tab2.id]).toBeUndefined()
    expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(false)
  })

  it('keeps the dot when a tab strip pick leaves another tab waiting', () => {
    const store = seed(tab1.id)
    store.setState({
      unreadTerminalTabs: { [tab1.id]: 'terminal-bell', [tab2.id]: 'terminal-bell' }
    })
    store.getState().setActiveWorktree(wt.id)

    store.getState().activateTab(tab2.id)

    expect(store.getState().unreadTerminalTabs[tab1.id]).toBe('terminal-bell')
    expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(true)
  })

  it('keeps the dot when activating the workspace onto a different tab', () => {
    const store = seed(tab1.id)

    store.getState().setActiveWorktree(wt.id)

    expect(store.getState().activeWorktreeId).toBe(wt.id)
    expect(store.getState().activeTabId).toBe(tab1.id)
    expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(true)
  })

  it('clears the dot when activation lands on the waiting tab', () => {
    const store = seed(tab2.id)

    store.getState().setActiveWorktree(wt.id)

    expect(store.getState().activeTabId).toBe(tab2.id)
    expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(false)
  })
})
