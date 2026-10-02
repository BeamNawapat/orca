// The capabilities that let a client send an agent's `default` (configured model) sentinel to a
// remote host for Source Control AI generation.

export const ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY =
  'git.antigravity-configured-model.v1' as const
// Why: older hosts pass `--model default` to `codex exec`, which Codex rejects.
export const CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY = 'git.codex-configured-model.v1' as const

export const SOURCE_CONTROL_CONFIGURED_MODEL_RUNTIME_CAPABILITIES = [
  ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
  CODEX_CONFIGURED_MODEL_RUNTIME_CAPABILITY
] as const
