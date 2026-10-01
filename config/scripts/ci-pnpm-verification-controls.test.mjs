import { describe, expect, it } from 'vitest'
import { pnpmVerificationOutcome } from './ci-pnpm-verification-controls.mjs'

describe('pnpm verification treatment evidence', () => {
  it('distinguishes a restored verdict from a fresh successful policy check', () => {
    expect(
      pnpmVerificationOutcome('✓ Lockfile passes supply-chain policies (verified 11h ago)')
    ).toBe('record-hit')
    expect(
      pnpmVerificationOutcome('✓ Lockfile passes supply-chain policies (1506 entries in 1m 33.1s)')
    ).toBe('fresh-verification')
  })

  it.each([
    'Lockfile is up to date, resolution step is skipped',
    'Cache restored successfully',
    '? Verifying lockfile against supply-chain policies (1506 entries)...',
    'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
    ''
  ])('does not count an unproven message as a successful policy verdict: %s', (stdout) => {
    expect(pnpmVerificationOutcome(stdout)).toBe('unrecognized')
  })
})
