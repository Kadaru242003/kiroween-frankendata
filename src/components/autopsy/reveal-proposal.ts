/**
 * After a Fix it handoff: wait for the approval screen to render the proposal
 * card, scroll the screen (and its sticky action bar) into view, flash the card
 * with the green glow, and move keyboard focus to it. Uses instant scrolling
 * under prefers-reduced-motion. Gives up quietly after about 2 seconds.
 */
export function revealProposalCard(proposalId: string): void {
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const started = Date.now()
  const attempt = () => {
    const card = document.getElementById(`proposal-card-${proposalId}`)
    if (card === null) {
      if (Date.now() - started < 2000) {
        window.setTimeout(attempt, 50)
      }
      return
    }
    const screen = card.closest('.approval-screen') ?? card
    const behavior = reduce ? 'auto' : 'smooth'
    screen.scrollIntoView?.({ behavior, block: 'start' })
    card.focus({ preventScroll: true })
    if (!reduce) {
      card.classList.add('stitch-proposal--flash')
      window.setTimeout(() => card.classList.remove('stitch-proposal--flash'), 1500)
    }
  }
  window.setTimeout(attempt, 0)
}
