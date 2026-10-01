import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { stop as stopEsbuild } from 'esbuild'
import {
  pnpmVerificationOutcome,
  runPnpmVerificationControls
} from './ci-pnpm-verification-controls.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

const { values } = parseArgs({
  options: {
    phase: { type: 'string' },
    treatment: { type: 'string' },
    sample: { type: 'string' }
  }
})
assert.equal(
  process.env.GITHUB_ACTIONS,
  'true',
  'This destructive install trial runs only in Actions'
)
assert(process.env.RUNNER_TEMP, 'RUNNER_TEMP must identify the disposable trial directory')
const root = resolve(import.meta.dirname, '../..')
const output = join(process.env.RUNNER_TEMP, 'pnpm-verification-trial')
const cache = join(output, 'cache')
const record = join(cache, 'lockfile-verified.jsonl')
const seedRecord = join(output, 'seed-record.jsonl')
const stateFile = join(output, 'state.json')
const startFile = join(output, 'start.json')
const manifests = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']
const pnpm = resolvePnpmCliInvocation()
mkdirSync(output, { recursive: true })

function command(args, isolated = false) {
  const result = runProcessSync({
    program: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd: root,
    env: {
      ...process.env,
      CI: 'true',
      ORCA_BACKGROUND_LAUNCH: '1',
      ...(isolated ? { PNPM_CONFIG_CACHE_DIR: cache } : {})
    },
    timeoutMs: 600_000
  })
  assert.equal(result.code, 0, describeProcessFailure(result))
  return result.stdout.trim()
}

function digestFiles(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file}\0`)
    if (file === '.npmrc' && !existsSync(join(root, file))) {
      hash.update('absent\0')
    } else {
      hash.update(readFileSync(join(root, file)))
    }
  }
  return hash.digest('hex')
}

function installedInputs() {
  const require = createRequire(join(root, 'package.json'))
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const versions = Object.fromEntries(
    Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    })
      .sort()
      .map((name) => {
        const path = join(root, 'node_modules', name, 'package.json')
        assert(existsSync(path), `Missing installed direct dependency ${name}`)
        return [name, JSON.parse(readFileSync(path, 'utf8')).version]
      })
  )
  for (const name of ['vitest', 'electron', 'esbuild', 'typescript', 'yaml']) {
    require.resolve(name)
  }
  return { versions, lockfile: digestFiles(['node_modules/.pnpm/lock.yaml']) }
}

function state() {
  return JSON.parse(readFileSync(stateFile, 'utf8'))
}
function write(name, value) {
  writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`)
}

if (values.phase === 'seed') {
  const defaultCache = command(['cache', 'path'])
  assert(
    existsSync(join(defaultCache, 'lockfile-verified.jsonl')),
    'Seed install did not create an authentic record'
  )
  cpSync(join(defaultCache, 'lockfile-verified.jsonl'), seedRecord)
  mkdirSync(cache, { recursive: true })
  cpSync(seedRecord, record)
  write('state.json', {
    source: digestFiles(manifests),
    installed: installedInputs(),
    store: resolve(command(['store', 'path'])),
    pnpm: command(['--version']),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runnerOS: process.env.RUNNER_OS,
    imageVersion: process.env.ImageVersion,
    recordBytes: readFileSync(record).length,
    recordDigest: createHash('sha256').update(readFileSync(record)).digest('hex')
  })
} else if (values.phase === 'begin') {
  assert(['baseline', 'restored'].includes(values.treatment), 'Unknown treatment')
  assert(/^[1-4]$/.test(values.sample ?? ''), 'Sample must be 1–4')
  write('start.json', {
    treatment: values.treatment,
    sample: Number(values.sample),
    started: Date.now()
  })
  rmSync(cache, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })
} else if (values.phase === 'measure') {
  const start = JSON.parse(readFileSync(startFile, 'utf8'))
  const expected = state()
  assert.equal(digestFiles(manifests), expected.source, 'Frozen policy inputs changed')
  assert.equal(
    resolve(command(['cache', 'path'], true)),
    resolve(cache),
    'pnpm ignored isolated metadata'
  )
  assert.equal(
    resolve(command(['store', 'path'], true)),
    expected.store,
    'Download-store treatment changed'
  )
  if (start.treatment === 'restored') {
    assert(existsSync(record), 'GitHub did not restore the verified record')
    assert.equal(
      createHash('sha256').update(readFileSync(record)).digest('hex'),
      expected.recordDigest
    )
  } else {
    assert(!existsSync(record), 'Baseline unexpectedly contains a verification record')
  }
  // Windows cannot remove the running bundler executable used to load our process wrapper.
  stopEsbuild()
  rmSync(join(root, 'node_modules'), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })
  const installStart = performance.now()
  const stdout = command(['install', '--frozen-lockfile', '--ignore-scripts'], true)
  const installMs = performance.now() - installStart
  const totalMs = Date.now() - start.started
  writeFileSync(join(output, `${start.sample}-${start.treatment}.log`), stdout)
  const outcome = pnpmVerificationOutcome(stdout)
  assert.equal(
    outcome,
    start.treatment === 'restored' ? 'record-hit' : 'fresh-verification',
    stdout
  )
  assert.equal(digestFiles(manifests), expected.source, 'Install mutated a frozen policy input')
  assert.deepEqual(installedInputs(), expected.installed, 'Installed versions or lockfile changed')
  const result = { ...start, installMs, totalMs, outcome }
  write(`${start.sample}-${start.treatment}.json`, result)
  console.log(JSON.stringify(result))
} else if (values.phase === 'finish') {
  const controls = runPnpmVerificationControls({ output: join(output, 'controls') })
  const results = Array.from({ length: 4 }, (_, index) =>
    ['baseline', 'restored'].map((treatment) =>
      JSON.parse(readFileSync(join(output, `${index + 1}-${treatment}.json`), 'utf8'))
    )
  ).flat()
  const median = (numbers) => {
    const sorted = numbers.toSorted((a, b) => a - b)
    return (sorted[1] + sorted[2]) / 2
  }
  const summary = Object.fromEntries(
    ['baseline', 'restored'].map((treatment) => {
      const samples = results.filter((result) => result.treatment === treatment)
      return [
        treatment,
        {
          installMs: median(samples.map((result) => result.installMs)),
          totalMs: median(samples.map((result) => result.totalMs))
        }
      ]
    })
  )
  const report = {
    ...state(),
    results,
    summary,
    controls,
    scope:
      'Four alternating pairs on one hosted runner; identical warm download store; fresh links and isolated registry metadata each time.',
    limit:
      'Total includes actual GitHub record restore and inter-step time. Seed download/store restore is common and excluded. This measures script-free desktop installs.'
  }
  write('report.json', report)
  console.log(JSON.stringify(report, null, 2))
} else {
  throw new Error('Use --phase seed, begin, measure or finish')
}
