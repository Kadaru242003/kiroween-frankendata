import { describe, expect, it } from 'vitest'

// Minimal smoke test confirming the Vitest toolchain is wired up:
// globals, the jsdom environment, and the jest-dom setup file all load.
describe('vitest toolchain', () => {
  it('runs a trivial assertion', () => {
    expect(1 + 1).toBe(2)
  })

  it('has a jsdom document available', () => {
    const el = document.createElement('div')
    el.textContent = 'frankendata'
    expect(el).toHaveTextContent('frankendata')
  })
})
