import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddRepoDialogChrome } from './AddRepoDialogChrome'

type OutsideHandler = (event: { preventDefault: () => void }) => void

const captured: { onInteractOutside?: OutsideHandler } = {}

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    onInteractOutside
  }: {
    children: ReactNode
    onInteractOutside?: OutsideHandler
  }) => {
    captured.onInteractOutside = onInteractOutside
    return <div>{children}</div>
  }
}))

vi.mock('./AddRepoStepIndicator', () => ({
  AddRepoStepIndicator: () => null
}))

function renderOutsideHandler(isCloning: boolean): OutsideHandler {
  renderToStaticMarkup(
    <AddRepoDialogChrome
      isAdding={false}
      isCloning={isCloning}
      isOpen
      onBack={() => {}}
      onOpenChange={() => {}}
      step="clone"
    >
      {null}
    </AddRepoDialogChrome>
  )
  if (!captured.onInteractOutside) {
    throw new Error('DialogContent has no onInteractOutside handler')
  }
  return captured.onInteractOutside
}

describe('AddRepoDialogChrome outside dismiss', () => {
  beforeEach(() => {
    captured.onInteractOutside = undefined
  })

  it('keeps the dialog open when the user clicks outside during a clone', () => {
    const preventDefault = vi.fn()
    renderOutsideHandler(true)({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('lets a click outside close the dialog when no clone is running', () => {
    const preventDefault = vi.fn()
    renderOutsideHandler(false)({ preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
