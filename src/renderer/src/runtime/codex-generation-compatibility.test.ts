import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { getRuntimeCommitMessageSettings } from './runtime-git-client-context'
import {
  generateRuntimeCommitMessage,
  generateRuntimePullRequestFields
} from './runtime-git-generation-client'

const mocks = vi.hoisted(() => ({
  supports: vi.fn(),
  rpc: vi.fn(),
  repos: [] as { id: string; sourceControlAi?: unknown }[]
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ repos: mocks.repos }) } }))
vi.mock('./runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'environment', environmentId: 'remote-test' }),
  runtimeEnvironmentSupportsCapability: mocks.supports,
  callRuntimeRpc: mocks.rpc
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repos = []
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

    it("honors the repository's explicit model override for settings-derived params", async () => {
      const hostKey =
        getRuntimeCommitMessageSettings(remoteSettings()).commitMessageDiscoveryHostKey!
      mocks.repos = [
        {
          id: 'wt-1',
          sourceControlAi: {
            modelOverridesByOperation: {
              [operation]: { selectedModelByAgentByHost: { [hostKey]: { codex: 'gpt-5.4' } } }
            }
          }
        }
      ]
      expect(await generate('default', false)).toMatchObject({ success: true })
      expect(mocks.supports).not.toHaveBeenCalled()
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
    })
  })
}
