import {
  ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
  CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { hasFlag } from '../../../shared/agent-cli-flag-detection'
import { planCommitMessageGeneration } from '../../../shared/commit-message-plan'
import { resolveSourceControlAiForOperation } from '../../../shared/source-control-ai'
import {
  getRuntimeCommitMessageSettings,
  type RuntimeGitContext,
  type RuntimeGenerateCommitMessageOverrides
} from './runtime-git-client-context'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

// Why: older servers build `--model default` for these agents, which the CLI rejects.
const CONFIGURED_MODEL_CAPABILITIES = {
  antigravity: {
    capability: ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
    label: 'Antigravity',
    modelFlags: ['--model']
  },
  codex: {
    capability: CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
    label: 'Codex',
    modelFlags: ['--model', '-m']
  }
} as const

export async function configuredModelGenerationCompatibilityError(
  environmentId: string,
  context: RuntimeGitContext,
  operation: 'commitMessage' | 'pullRequest',
  overrides?: RuntimeGenerateCommitMessageOverrides
): Promise<string | null> {
  let params = overrides?.sourceControlAiResolvedParams
  if (!params) {
    const settings = getRuntimeCommitMessageSettings(context.settings, context.connectionId)
    const resolved = resolveSourceControlAiForOperation({
      settings: {
        ...settings,
        defaultTuiAgent: context.settings?.defaultTuiAgent ?? null,
        sourceControlAi: overrides?.sourceControlAi ?? settings.sourceControlAi,
        agentCmdOverrides: overrides?.agentCmdOverrides ?? settings.agentCmdOverrides ?? {}
      },
      // Why: the server applies the repo's model override, so the gate must see it too.
      repo: await findRepoForWorktree(context.worktreeId),
      operation,
      discoveryHostKey: settings.commitMessageDiscoveryHostKey
    })
    if (resolved.ok) {
      params = resolved.value.params
    }
  }
  if (
    !params ||
    params.model !== 'default' ||
    !Object.hasOwn(CONFIGURED_MODEL_CAPABILITIES, params.agentId)
  ) {
    return null
  }
  const { capability, label, modelFlags } =
    CONFIGURED_MODEL_CAPABILITIES[params.agentId as keyof typeof CONFIGURED_MODEL_CAPABILITIES]
  const planned = planCommitMessageGeneration(params, '')
  // A recipe or command override can already supply a model that older planners understand.
  if (planned.ok && hasFlag(planned.plan.args, modelFlags)) {
    return null
  }
  if (await runtimeEnvironmentSupportsCapability(environmentId, capability)) {
    return null
  }
  return `This remote Orca server does not support ${label}’s configured model. Update the remote server or select an explicit ${label} model.`
}

async function findRepoForWorktree(worktreeId: string | null | undefined) {
  if (!worktreeId) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  // Why: store slices import the generation client, so a static store import would cycle.
  const { useAppStore } = await import('@/store')
  return useAppStore.getState().repos.find((repo) => repo.id === repoId) ?? null
}
