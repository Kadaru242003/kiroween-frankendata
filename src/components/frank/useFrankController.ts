/**
 * Little Frank's controller hook: owns the reaction queue, its timers, the
 * speech bubble, idle sleep, the poke count and the Calm Frank preference. The
 * decisions themselves live in the pure `src/core/frank/reactions.ts`; this hook
 * only keeps time. It never throws into the app and never waits on an animation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readCalm, writeCalm } from "../../core/frank/calm";
import { FRANK_BUBBLE_MS, FRANK_IDLE_MS } from "../../core/frank/constants";
import {
  EMPTY_QUEUE,
  NO_POKES,
  enqueue,
  finish,
  pokeStep,
  reactionFor,
  type FrankEvent,
  type PokeState,
  type QueueState,
  type Reaction,
} from "../../core/frank/reactions";

export interface FrankView {
  reaction: Reaction | null;
  reactionSeq: number;
  bubble: string | null;
}

export interface FrankController extends FrankView {
  /** Tell Frank something happened. */
  emit: (event: FrankEvent) => void;
  /** Poke him (from the guide). */
  poke: () => void;
  /** No activity for FRANK_IDLE_MS: he sleeps until the next activity. */
  idle: boolean;
  calm: boolean;
  setCalm: (on: boolean) => void;
}

export interface FrankControllerOptions {
  /** Idle time before he sleeps (tests shorten it). */
  idleMs?: number;
}

export function useFrankController(options: FrankControllerOptions = {}): FrankController {
  const idleMs = options.idleMs ?? FRANK_IDLE_MS;
  const [view, setView] = useState<FrankView>({ reaction: null, reactionSeq: 0, bubble: null });
  const [idle, setIdle] = useState(false);
  const [calm, setCalmState] = useState<boolean>(() => readCalm());

  const queueRef = useRef<QueueState>(EMPTY_QUEUE);
  const pokeRef = useRef<PokeState>(NO_POKES);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show the queue's current reaction and time its end. The queue is a pure
  // value; the timers are the only clock.
  const run = useCallback(() => {
    const q = queueRef.current;
    if (reactionTimer.current !== null) clearTimeout(reactionTimer.current);
    reactionTimer.current = null;
    const current = q.current;
    if (current === null) {
      setView((v) => ({ ...v, reaction: null }));
      return;
    }
    setView((v) => ({
      reaction: current,
      reactionSeq: q.seq,
      bubble: current.bubble ?? v.bubble,
    }));
    if (current.bubble !== null) {
      if (bubbleTimer.current !== null) clearTimeout(bubbleTimer.current);
      bubbleTimer.current = setTimeout(() => {
        setView((v) => ({ ...v, bubble: null }));
      }, FRANK_BUBBLE_MS);
    }
    reactionTimer.current = setTimeout(() => {
      queueRef.current = finish(queueRef.current);
      run();
    }, current.durationMs);
  }, []);

  const play = useCallback(
    (reaction: Reaction) => {
      const before = queueRef.current;
      const next = enqueue(before, reaction);
      queueRef.current = next;
      if (next.current !== before.current || next.seq !== before.seq) run();
    },
    [run]
  );

  const emit = useCallback(
    (event: FrankEvent) => {
      try {
        const reaction = reactionFor(event);
        if (reaction) play(reaction);
      } catch {
        /* a failed event is dropped; the app never sees it */
      }
    },
    [play]
  );

  const poke = useCallback(() => {
    const step = pokeStep(pokeRef.current, Date.now());
    pokeRef.current = step.state;
    play(step.reaction);
  }, [play]);

  const setCalm = useCallback((on: boolean) => {
    setCalmState(on);
    writeCalm(on);
  }, []);

  // Idle sleep: any pointer, key or scroll activity wakes him; FRANK_IDLE_MS of
  // quiet puts him to sleep. The handler only records a timestamp, so it is cheap.
  useEffect(() => {
    let last = Date.now();
    let sleeping = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number) => {
      timer = setTimeout(check, ms);
    };
    const check = () => {
      const quiet = Date.now() - last;
      if (quiet >= idleMs) {
        sleeping = true;
        setIdle(true);
      } else {
        arm(idleMs - quiet);
      }
    };
    const onActivity = () => {
      last = Date.now();
      if (sleeping) {
        sleeping = false;
        setIdle(false);
        if (timer !== null) clearTimeout(timer);
        arm(idleMs);
      }
    };
    arm(idleMs);
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, onActivity, { passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, onActivity);
      if (timer !== null) clearTimeout(timer);
    };
  }, [idleMs]);

  useEffect(
    () => () => {
      if (reactionTimer.current !== null) clearTimeout(reactionTimer.current);
      if (bubbleTimer.current !== null) clearTimeout(bubbleTimer.current);
    },
    []
  );

  return { ...view, emit, poke, idle, calm, setCalm };
}
