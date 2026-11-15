# Implementation Plan: Little Frank

## Overview

Pure core first (constants, reactions and queue, poke, guide, calm), then the event plumbing (bus, hooks), then the drawing (Specimen, Effects, Poses), then the Guide panel, then the app wiring, then the tests that need the browser. Every group ends with `npm run build`.

**Conventions:** property tests use `fast-check`, one invariant per file, tagged in the header comment. No new dependency. No em dash in any user-facing text. No change to what any store or handler does.

## Tasks

- [x] 1. Constants, reactions, queue, poke (pure)
  - Create `src/core/frank/constants.ts` and `reactions.ts`: `FrankEvent`, `Reaction`, `reactionFor`, the queue, `pokeReaction`, `nextPokeCount`
  - Unit tests; Property 1, 2 and 4 tests
  - _Design: Events and Reactions, Queue, Poking; Requirements 1, 2, 3, 4, 6, 13.1, 13.2, 13.4_
- [x] 2. Guide core (pure)
  - Create `src/core/frank/guide.ts`: 17 Intents, matcher, answers (privacy from `describeEgress()`), chips, fallback, `contextTip`
  - Unit tests; Property 3 and 5 tests; the no-network source scan
  - _Design: Guide; Requirements 8.4, 9, 10, 11, 13.3, 13.5_
- [x] 3. Calm preference and event bus
  - Create `src/core/frank/calm.ts` and `src/state/frank-bus.ts` with tests
  - _Design: Motion safety, Error handling; Requirements 7.5, 1.5_
- [x] 4. Checkpoint: `npm run build` and the touched tests
- [x] 5. Event hooks
  - Create `useFrankEvents` (stores, props, bus to FrankEvents) and `useFrankController` (queue, timers, bubble, idle, calm, poke)
  - _Design: Architecture, Event sources; Requirements 1.5, 2.3, 2.4, 5.1_
- [x] 6. Drawing: Specimen, Effects, Poses
  - Extend `Specimen.tsx` and `Specimen.css`: neck bolts, head group, Effects per Reaction, flash and lightning, stethoscope, flask, smoke, eye follow, reduced motion and calm paths
  - Update `Specimen.smoke.test.tsx`
  - _Design: Motion safety; Requirements 2, 3, 4, 5, 7_
- [x] 7. Guide panel
  - Create `FrankGuide.tsx` and `.css`: dialog, focus trap, Esc and outside click, input, chips, answer, tip, Poke button, Calm toggle
  - Smoke tests
  - _Design: Guide; Requirements 6.1, 7.5, 8, 11_
- [x] 8. App wiring
  - `FrankRegion` replaces `SpecimenRegion`; `frankBus.emit` next to the Autopsy, recipe and export handlers; `onScored`, `onFixedAll`, `onExported` props
  - _Design: Event sources; Requirements 1.5, 3, 4, 12_
- [x] 9. Checkpoint: `npm run build`, `npm run check:api`, `npm run mcp:build`, touched tests
- [x] 10. Playwright
  - Lightning and "IT'S ALIVE!", the privacy answer, Esc, reduced motion, clicks pass through
  - _Design: Correctness properties and tests; Requirements 2, 7, 8, 10_
- [x] 11. Final checks and notes
  - Full `npm test`, `npm run build`, `npm run check:api`, `npm run mcp:build`, `npm run test:e2e`
  - `NOTES.md`, commit
  - _Requirements: all_

## Revision 2 tasks

- [ ] 12. Spec: requirements 14 to 17, design Revision 2, these tasks
- [ ] 13. Bolt generator (pure) with unit and property tests
  - `lightning.ts`, `lightning.test.ts`, `lightning.property.test.ts`
  - _Requirements: 14.1; Property 6_
- [ ] 14. Voice: intents, reaction bubbles, quips (pure)
  - Rewrite answers and bubbles; add Who, Eat, Read, Frankenstein, Born intents; `quips.ts`; `autopsy-open` and `quip` events; tests and properties 7 and 8
  - _Requirements: 16; Property 3, 7, 8_
- [ ] 15. Look: patchwork SVG, new seam, satchel, sleeve
  - _Requirements: 17_
- [ ] 16. Lightning rendering, flash, impact, shake, reduced motion
  - _Requirements: 14.2 to 14.8_
- [ ] 17. Interaction: poke on tap, "?" button, comic bubble guide, typewriter answer above the chips
  - _Requirements: 15_
- [ ] 18. Tests and gate: update unit and smoke tests, add e2e (tap pokes, "?" opens, acorns answer, answer above chips, reduced motion no bolt), full gate, NOTES.md
  - _Requirements: all_
