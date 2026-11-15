/**
 * Named constants for Little Frank (spec: frankendata-little-frank). Tests and
 * the UI reference these instead of hard-coding literals.
 */

/** The longest any Reaction animation may run. */
export const FRANK_REACTION_MAX_MS = 1500;
/** How long a speech bubble stays after its Reaction starts. */
export const FRANK_BUBBLE_MS = 2600;
/** Quiet time after which Frank falls asleep. */
export const FRANK_IDLE_MS = 60000;
/** How near the cursor must be for his eyes to follow it. */
export const FRANK_EYE_RANGE_PX = 280;
/** Pokes in a row that trigger the easter egg. */
export const FRANK_POKE_EGG_COUNT = 10;
/** Pause between pokes after which the poke count starts again. */
export const FRANK_POKE_RESET_MS = 6000;
/** The localStorage key of the Calm Frank preference. */
export const FRANK_CALM_STORAGE_KEY = "frankendata.calmFrank";
/** The fewest Intents the guide table holds. */
export const GUIDE_MIN_INTENTS = 15;
/** How long the bolt flickers (on, off, on, off, on). */
export const FRANK_BOLT_FLICKER_MS = 350;
/** How long the bolt fades after the flicker. */
export const FRANK_BOLT_FADE_MS = 250;
/** How long the white screen flash lasts. */
export const FRANK_FLASH_MS = 80;
/** How long the page shakes on impact. */
export const FRANK_SHAKE_MS = 150;
/** The least time between two idle quips. */
export const FRANK_QUIP_GAP_MS = 120000;
/** How long the user must have been still before a quip may play. */
export const FRANK_QUIP_QUIET_MS = 15000;
