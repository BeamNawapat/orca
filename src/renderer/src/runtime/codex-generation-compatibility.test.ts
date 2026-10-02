import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { getRuntimeCommitMessageSettings } from './runtime-git-client-context'
import {
  generateRuntimeCommitMessage,
  generateRuntimePullRequestFields
} from './runtime-git-generation-client'

type RepoRow = { id: string; executionHostId?: string; sourceControlAi?: unknown }
type WorktreeRow = { id: string; hostId?: string }

const mocks = vi.hoisted(() => {
  const repos: RepoRow[] = []
  const worktreesByRepo: Record<string, WorktreeRow[]> = {}
  return { supports: vi.fn(), rpc: vi.fn(), repos, worktreesByRepo }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ repos: mocks.repos, worktreesByRepo: mocks.worktreesByRepo })
  }
}))
vi.mock('./runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'environment', environmentId: 'remote-test' }),
  runtimeEnvironmentSupportsCapability: mocks.supports,
  callRuntimeRpc: mocks.rpc
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repos = []
  mocks.worktreesByRepo = {}
  mocks.supports.mockResolvedValue(false)
  mocks.rpc.mockResolvedValue({ success: true })
})

for (const operation of ['commitMessage', 'pullRequest'] as const) {
  describe(operation, () => {
    function remoteSettings() {
      const settings = getDefaultSettings('/tmp')
      settings.activeRuntimeEnvironmentId = 'remote-test'
      settings.sourceControlAi = { ...settings.sourceControlAi!, agentId: 'codex' }
      return settings
    }

    function generate(model: string, resolved = true, agentArgs?: string) {
      const settings = remoteSettings()
      const context = { settings, worktreeId: 'wt-1', worktreePath: '/remote/workspace' }
      const overrides = resolved
        ? {
            sourceControlAiResolvedParams: {
              agentId: 'codex' as const,
              model,
              ...(agentArgs ? { agentArgs } : {})
            }
          }
        : undefined
      return operation === 'commitMessage'
        ? generateRuntimeCommitMessage(context, overrides)
        : generateRuntimePullRequestFields(
            context,
            { base: 'main', title: '', body: '', draft: true },
            overrides
          )
    }

    it('does not send the Codex default sentinel to an older server', async () => {
      expect(await generate('default')).toMatchObject({
        success: false,
        error: expect.stringContaining('select an explicit Codex model')
      })
      expect(mocks.rpc).not.toHaveBeenCalled()
      expect(mocks.supports).toHaveBeenCalledWith(
        'remote-test',
        CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY
      )
    })

    it('guards the settings-derived Codex default as well as one-shot selections', async () => {
      expect(await generate('default', false)).toMatchObject({ success: false })
      expect(mocks.rpc).not.toHaveBeenCalled()
    })

    it('sends the sentinel to a server that supports the Codex configured model', async () => {
      mocks.supports.mockResolvedValue(true)
      expect(await generate('default')).toMatchObject({ success: true })
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })

    it('keeps explicit Codex models usable on older servers', async () => {
      expect(await generate('gpt-5.4')).toMatchObject({ success: true })
      expect(mocks.supports).not.toHaveBeenCalled()
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })

    it('accepts an explicit model supplied through the recipe CLI arguments', async () => {
      expect(await generate('default', true, '--model gpt-5.4')).toMatchObject({ success: true })
      expect(mocks.supports).not.toHaveBeenCalled()
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })

    it('accepts the -m short form of an explicit recipe model', async () => {
      expect(await generate('default', true, '-m gpt-5.4')).toMatchObject({ success: true })
      expect(mocks.supports).not.toHaveBeenCalled()
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })

    it('still guards a recipe that passes the default sentinel as its model flag', async () => {
      for (const agentArgs of [
        '--model default',
        '--model=default',
        '-m default',
        '-mdefault',
        '--model Default',
        '--model --json'
      ]) {
        mocks.rpc.mockClear()
        expect(await generate('default', true, agentArgs)).toMatchObject({ success: false })
        expect(mocks.rpc).not.toHaveBeenCalled()
      }
    })

    function repoWithCodexModel(executionHostId?: string) {
      const hostKey =
        getRuntimeCommitMessageSettings(remoteSettings()).commitMessageDiscoveryHostKey!
      return {
        id: 'wt-1',
        ...(executionHostId ? { executionHostId } : {}),
        sourceControlAi: {
          modelOverridesByOperation: {
            [operation]: { selectedModelByAgentByHost: { [hostKey]: { codex: 'gpt-5.4' } } }
          }
        }
      }
    }

    it('reads the repository row for the remote host when ids repeat across hosts', async () => {
      mocks.repos = [
        repoWithCodexModel('ssh:other'),
        { id: 'wt-1', executionHostId: 'runtime:remote-test' }
      ]
      expect(await generate('default', false)).toMatchObject({ success: false })
      expect(mocks.rpc).not.toHaveBeenCalled()

      mocks.repos = [
        { id: 'wt-1', executionHostId: 'ssh:other' },
        repoWithCodexModel('runtime:remote-test')
      ]
      expect(await generate('default', false)).toMatchObject({ success: true })
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })

    it('ignores a lone repository row that belongs to another host', async () => {
      mocks.repos = [repoWithCodexModel('ssh:other')]
      expect(await generate('default', false)).toMatchObject({ success: false })
      expect(mocks.rpc).not.toHaveBeenCalled()
    })

    it("reads the repository row for the worktree's own host", async () => {
      mocks.worktreesByRepo = { 'wt-1': [{ id: 'wt-1', hostId: 'ssh:runtime-box' }] }
      mocks.repos = [repoWithCodexModel('ssh:runtime-box')]
      expect(await generate('default', false)).toMatchObject({ success: true })
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })

    it("honors the repository's explicit model override for settings-derived params", async () => {
      mocks.repos = [repoWithCodexModel('runtime:remote-test')]
      expect(await generate('default', false)).toMatchObject({ success: true })
      expect(mocks.supports).not.toHaveBeenCalled()
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })
  })
}
