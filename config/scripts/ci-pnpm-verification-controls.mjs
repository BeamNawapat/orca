import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parse, parseAllDocuments, stringify } from 'yaml'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const recordName = 'lockfile-verified.jsonl'

export function pnpmVerificationOutcome(stdout) {
  if (/Lockfile passes supply-chain policies \(verified [^)]+\)/.test(stdout)) {
    return 'record-hit'
  }
  if (/Lockfile passes supply-chain policies \([^)]* in [^)]+\)/.test(stdout)) {
    return 'fresh-verification'
  }
  return 'unrecognized'
}

export function runPnpmVerificationControls({ output } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'orca-pnpm-verification-controls-'))
  const pnpm = resolvePnpmCliInvocation()
  const source = parseAllDocuments(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
    .map((document) => document.toJS())
    .find((document) => document.packages?.['is-number@7.0.0'])
  const packageManager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager
  const policy = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  const dependency = 'is-number@7.0.0'
  assert(
    source?.packages[dependency]?.resolution.integrity,
    'control needs the locked is-number tarball'
  )
  const fixture = {
    lockfileVersion: source.lockfileVersion,
    settings: source.settings,
    importers: { '.': { dependencies: { 'is-number': { specifier: '7.0.0', version: '7.0.0' } } } },
    packages: { [dependency]: source.packages[dependency] },
    snapshots: { [dependency]: source.snapshots[dependency] }
  }
  const basePolicy = { minimumReleaseAge: policy.minimumReleaseAge }
  const results = []
  const store = join(temporary, 'store')

  function command(args, cwd, cache) {
    return runProcessSync({
      program: pnpm.command,
      args: [...pnpm.prefixArgs, ...args],
      cwd,
      env: {
        ...process.env,
        CI: 'true',
        ORCA_BACKGROUND_LAUNCH: '1',
        PNPM_CONFIG_FETCH_RETRIES: '0',
        PNPM_CONFIG_CACHE_DIR: cache,
        PNPM_CONFIG_STORE_DIR: store
      },
      timeoutMs: 180_000
    })
  }

  function install(name, { record, corrupt = false, strict = false, changed = false } = {}) {
    const cwd = join(temporary, name)
    const cache = join(temporary, `${name}-cache`)
    mkdirSync(cwd)
    mkdirSync(cache)
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'orca-verification-control',
        private: true,
        dependencies: { 'is-number': '7.0.0' }
      })
    )
    const lockfile = structuredClone(fixture)
    if (changed) {
      lockfile.packages[dependency].resolution.integrity =
        `sha512-${Buffer.alloc(64).toString('base64')}`
    }
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), stringify(lockfile))
    writeFileSync(
      join(cwd, 'pnpm-workspace.yaml'),
      stringify(strict ? { minimumReleaseAge: 100_000_000 } : basePolicy)
    )
    if (record) {
      cpSync(record, join(cache, recordName))
    }
    if (corrupt) {
      writeFileSync(join(cache, recordName), '{"not":"a verification record"}\n')
    }
    for (const [args, expected] of [
      [['cache', 'path'], cache],
      [['store', 'path'], join(store, 'v11')]
    ]) {
      const path = command(args, cwd, cache)
      assert.equal(path.code, 0, describeProcessFailure(path))
      assert.equal(
        resolve(path.stdout.trim()),
        resolve(expected),
        `${name}: pnpm ignored its isolated path override`
      )
    }
    const version = command(['--version'], cwd, cache)
    assert.equal(version.code, 0, describeProcessFailure(version))
    assert.equal(version.stdout.trim(), packageManager.split('@')[1].split('+')[0])
    const frozen = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((file) => [
      file,
      readFileSync(join(cwd, file))
    ])
    const result = command(['install', '--frozen-lockfile', '--ignore-scripts'], cwd, cache)
    for (const [file, bytes] of frozen) {
      assert.deepEqual(readFileSync(join(cwd, file)), bytes, `${name}: changed ${file}`)
    }
    const outcome = pnpmVerificationOutcome(result.stdout)
    results.push({ name, code: result.code, outcome })
    if (output) {
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, `${name}.log`), `${result.stdout}\n${result.stderr}`)
    }
    return { result, outcome, record: join(cache, recordName) }
  }

  try {
    const seed = install('seed')
    assert.equal(seed.result.code, 0, describeProcessFailure(seed.result))
    assert.equal(seed.outcome, 'fresh-verification')
    const warm = install('restored-record', { record: seed.record })
    assert.equal(warm.result.code, 0, describeProcessFailure(warm.result))
    assert.equal(warm.outcome, 'record-hit')
    for (const [name, options] of [
      ['missing-record', {}],
      ['corrupt-record', { corrupt: true }]
    ]) {
      const control = install(name, options)
      assert.equal(control.result.code, 0, describeProcessFailure(control.result))
      assert.equal(control.outcome, 'fresh-verification')
    }
    for (const [name, options, failure] of [
      [
        'stricter-policy',
        { record: seed.record, strict: true },
        /ERR_PNPM_(?:MINIMUM_RELEASE_AGE_VIOLATION|LOCKFILE_RESOLUTION_VERIFICATION)/
      ],
      ['changed-lockfile', { record: seed.record, changed: true }, /ERR_PNPM_TARBALL_INTEGRITY/]
    ]) {
      const control = install(name, options)
      assert.notEqual(control.result.code, 0, `${name}: unexpectedly accepted the cached verdict`)
      assert.notEqual(control.outcome, 'record-hit')
      assert.match(`${control.result.stdout}\n${control.result.stderr}`, failure)
    }
    const report = { platform: process.platform, arch: process.arch, results }
    if (output) {
      writeFileSync(join(output, 'controls.json'), `${JSON.stringify(report, null, 2)}\n`)
    }
    return report
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1]?.endsWith('ci-pnpm-verification-controls.mjs')) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } })
  console.log(
    JSON.stringify(
      runPnpmVerificationControls({ output: values.output ? resolve(values.output) : undefined }),
      null,
      2
    )
  )
}
