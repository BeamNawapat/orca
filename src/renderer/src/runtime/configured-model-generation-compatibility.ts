import {
  ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
  CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { agentArgOptionTokens } from '../../../shared/agent-session-option-agent-args'
import { planCommitMessageGeneration } from '../../../shared/commit-message-plan'
import { resolveSourceControlAiForOperation } from '../../../shared/source-control-ai'
import {
  getRuntimeCommitMessageSettings,
  type RuntimeGitContext,
  type RuntimeGenerateCommitMessageOverrides
} from './runtime-git-client-context'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  getWorktreeExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
import { findRepoForHost } from '../store/slices/repo-host-identity'
import { findWorktreeById } from '../store/slices/worktree-helpers'

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

function isConfiguredModelAgent(
  agentId: string
): agentId is keyof typeof CONFIGURED_MODEL_CAPABILITIES {
  return Object.hasOwn(CONFIGURED_MODEL_CAPABILITIES, agentId)
}

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
      repo: await findRepoForWorktree(context.worktreeId, environmentId),
      operation,
      discoveryHostKey: settings.commitMessageDiscoveryHostKey
    })
    if (resolved.ok) {
      params = resolved.value.params
    }
  }
  if (!params || params.model !== 'default' || !isConfiguredModelAgent(params.agentId)) {
    return null
  }
  const { capability, label, modelFlags } = CONFIGURED_MODEL_CAPABILITIES[params.agentId]
  const planned = planCommitMessageGeneration(params, '')
  // A recipe or command override can already supply a model that older planners understand.
  if (planned.ok && hasExplicitModelFlag(planned.plan.args, modelFlags)) {
    return null
  }
  if (await runtimeEnvironmentSupportsCapability(environmentId, capability)) {
    return null
  }
  return `This remote Orca server does not support ${label}’s configured model. Update the remote server or select an explicit ${label} model.`
}

// Why: `--model default` still reaches an older server as the rejected sentinel, so only a real
// model name in the args makes the request safe without the capability.
function hasExplicitModelFlag(args: readonly string[], flags: readonly string[]): boolean {
  const tokens = agentArgOptionTokens(args)
  return tokens.some((token, index) =>
    flags.some((flag) => {
      if (token === flag) {
        return isExplicitModel(tokens[index + 1])
      }
      if (token.startsWith(`${flag}=`)) {
        return isExplicitModel(token.slice(flag.length + 1))
      }
      // Clustered short flag such as `-mgpt-5`.
      return (
        !flag.startsWith('--') &&
        token.startsWith(flag) &&
        isExplicitModel(token.slice(flag.length))
      )
    })
  )
}

function isExplicitModel(value: string | undefined): boolean {
  const model = value?.trim()
  return !!model && !model.startsWith('-') && model.toLowerCase() !== 'default'
}

async function findRepoForWorktree(worktreeId: string | null | undefined, environmentId: string) {
  if (!worktreeId) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  // Why: store slices import the generation client, so a static store import would cycle.
  const { useAppStore } = await import('@/store')
  const state = useAppStore.getState()
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  const runtimeHostId = toRuntimeExecutionHostId(environmentId)
  // Why: the server applies the repo row for the worktree's own host. Repo ids can repeat across
  // hosts, so only rows on this worktree's host or the target runtime count; with no such row the
  // gate uses no repo override rather than another host's.
  const hostIds = new Set([
    worktree ? getWorktreeExecutionHostId(worktree, undefined, runtimeHostId) : runtimeHostId,
    runtimeHostId
  ])
  for (const hostId of hostIds) {
    const repo = findRepoForHost(state.repos, repoId, { hostId })
    if (repo) {
      return repo
    }
  }
  return null
}
