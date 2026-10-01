import { describe, expect, it } from 'vitest'
import { getUnresolvedSmartGitHubSubmitMessage } from './github-submit-unresolved-message'

const GENERIC = 'Could not resolve the GitHub item before creating the workspace.'

describe('getUnresolvedSmartGitHubSubmitMessage', () => {
  it('names the linked issue when a pasted URL cannot be loaded for the project', () => {
    expect(
      getUnresolvedSmartGitHubSubmitMessage(
        { kind: 'link', owner: 'org', repo: 'app-client-a', number: 144, type: 'issue' },
        true
      )
    ).toBe(
      'Could not load org/app-client-a#144. Check that it exists, that you can access it, and that it belongs to the origin or upstream repository of the selected project.'
    )
  })

  it('names pull request links the same way', () => {
    expect(
      getUnresolvedSmartGitHubSubmitMessage(
        { kind: 'link', owner: 'org', repo: 'other', number: 9, type: 'pr' },
        true
      )
    ).toContain('org/other#9')
  })

  it('keeps the GitHub Enterprise host so the repository is unambiguous', () => {
    expect(
      getUnresolvedSmartGitHubSubmitMessage(
        {
          kind: 'link',
          host: 'ghe.example.com',
          owner: 'org',
          repo: 'app',
          number: 3,
          type: 'issue'
        },
        true
      )
    ).toContain('ghe.example.com/org/app#3')
  })

  it('keeps the generic message for #number lookups', () => {
    expect(getUnresolvedSmartGitHubSubmitMessage({ kind: 'hash-number', number: 7 }, true)).toBe(
      GENERIC
    )
  })

  it('keeps the generic message when no single git project was looked up', () => {
    // Project groups search several repositories; folder projects never run the lookup.
    expect(
      getUnresolvedSmartGitHubSubmitMessage(
        { kind: 'link', owner: 'org', repo: 'app', number: 1, type: 'issue' },
        false
      )
    ).toBe(GENERIC)
  })
})
