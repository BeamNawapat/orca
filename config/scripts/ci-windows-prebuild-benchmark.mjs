import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import {
  validateWindowsPrebuildCache,
  windowsPrebuildCacheIdentity
} from './orcad-windows-prebuild-cache.mjs'
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
  'This destructive prebuild trial runs only in Actions'
)
assert.equal(process.platform, 'win32')
assert(process.env.RUNNER_TEMP)
const identity = windowsPrebuildCacheIdentity()
const output = join(process.env.RUNNER_TEMP, 'windows-prebuild-trial')
const pnpm = resolvePnpmCliInvocation()
mkdirSync(output, { recursive: true })
const read = (name) => JSON.parse(readFileSync(join(output, name), 'utf8'))
const write = (name, value) =>
  writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`)

function command(args) {
  const result = runProcessSync({
    program: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 600_000
  })
  assert.equal(result.code, 0, describeProcessFailure(result))
  return `${result.stdout}\n${result.stderr}`
}

function payload() {
  const manifest = readFileSync(join(identity.path, 'manifest.json'))
  const entry = JSON.parse(manifest).slots[identity.slot]
  const hash = createHash('sha256').update(manifest)
  let bytes = manifest.length
  for (const file of Object.keys(entry.files).sort()) {
    const path = join(identity.path, identity.slot, file)
    hash.update(file).update(readFileSync(path))
    bytes += statSync(path).size
  }
  return { bytes, digest: hash.digest('hex') }
}

if (values.phase === 'seed') {
  validateWindowsPrebuildCache()
  write('state.json', {
    identity,
    payload: payload(),
    node: process.version,
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion
  })
} else if (values.phase === 'begin') {
  assert(['fresh', 'restored'].includes(values.treatment))
  assert(/^[1-4]$/.test(values.sample ?? ''))
  write('start.json', {
    treatment: values.treatment,
    sample: Number(values.sample),
    started: Date.now()
  })
  rmSync(identity.path, { recursive: true, force: true })
} else if (values.phase === 'measure') {
  const start = read('start.json')
  const expected = read('state.json')
  assert.deepEqual(identity, expected.identity, 'Build inputs changed between treatments')
  const workStart = performance.now()
  let log = ''
  if (start.treatment === 'fresh') {
    log += command(['build:orcad-prebuilds'])
  } else {
    assert(
      existsSync(join(identity.path, 'manifest.json')),
      'Cache consumer did not restore the slot'
    )
    assert.deepEqual(payload(), expected.payload, 'Cache consumer received different payload bytes')
  }
  validateWindowsPrebuildCache()
  log += command(['build:orcad-prebuilds', '--require-slots', identity.slot])
  log += command(['build:orcad-prebuilds', '--smoke'])
  const workMs = performance.now() - workStart
  const totalMs = Date.now() - start.started
  writeFileSync(join(output, `${start.sample}-${start.treatment}.log`), log)
  const result = { ...start, workMs, totalMs, payload: payload() }
  write(`${start.sample}-${start.treatment}.json`, result)
  console.log(JSON.stringify(result))
} else if (values.phase === 'finish') {
  const results = Array.from({ length: 4 }, (_, index) =>
    ['fresh', 'restored'].map((treatment) => read(`${index + 1}-${treatment}.json`))
  ).flat()
  const median = (numbers) => {
    const sorted = numbers.toSorted((a, b) => a - b)
    return (sorted[1] + sorted[2]) / 2
  }
  const summary = Object.fromEntries(
    ['fresh', 'restored'].map((treatment) => {
      const samples = results.filter((result) => result.treatment === treatment)
      return [
        treatment,
        {
          workMs: median(samples.map((result) => result.workMs)),
          totalMs: median(samples.map((result) => result.totalMs))
        }
      ]
    })
  )
  const report = {
    ...read('state.json'),
    results,
    summary,
    scope:
      'Four alternating fresh-build/cache-consumer pairs on the same Windows host, with identical pinned inputs and all validation and smoke gates.',
    limit:
      'Total includes actual GitHub cache restores and inter-step time. Initial seed compilation and common dependency installation are excluded.'
  }
  write('report.json', report)
  console.log(JSON.stringify(report, null, 2))
} else {
  throw new Error('Use --phase seed, begin, measure or finish')
}
