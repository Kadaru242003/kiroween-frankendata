/**
 * The one event source for Little Frank. It watches state the app already has
 * (the table count, the stitch store, the ask store, the AI switch, whether the
 * stitch screen is open) plus the {@link FrankBus} (things no store records),
 * and turns changes into {@link FrankEvent}s for the controller. It only reads:
 * nothing here changes what any store or handler does.
 */

import { useEffect, useRef } from "react";
import type { FrankEvent } from "../../core/frank/reactions";
import type { StitchStore, StitchState } from "../../core/stitching/stitch-store";
import type { AskStore, AskState } from "../../state/ask-store";
import { frankBus } from "../../state/frank-bus";

export interface FrankEventSources {
  emit: (event: FrankEvent) => void;
  /** Loaded tables. */
  tableCount: number;
  stitchStore: StitchStore;
  askStore: AskStore;
  /** The AI switch is On. */
  aiOn: boolean;
  /** The stitch approval screen is open. */
  stitchOpen: boolean;
  /** Reset lab is running (store changes during it are not user events). */
  resetting: boolean;
  /** True while a demo replaces the tables (he does not die, he is reloaded). */
  quietResetRef?: { current: boolean };
}

export function useFrankEvents(sources: FrankEventSources): void {
  const { tableCount, aiOn, stitchOpen, stitchStore, askStore } = sources;
  const emitRef = useRef(sources.emit);
  emitRef.current = sources.emit;
  const resettingRef = useRef(sources.resetting);
  resettingRef.current = sources.resetting;
  const tableCountRef = useRef(tableCount);
  tableCountRef.current = tableCount;
  const quietRef = sources.quietResetRef;

  const emit = (event: FrankEvent) => {
    try {
      emitRef.current(event);
    } catch {
      /* never break the app */
    }
  };

  // 1. The table count: wake, files loaded, reset.
  const prevCount = useRef(tableCount);
  const skipWake = useRef(false);
  useEffect(() => {
    const prev = prevCount.current;
    prevCount.current = tableCount;
    if (prev === 0 && tableCount > 0) {
      if (skipWake.current) {
        // A demo replaced the tables: he was not dead, so he catches them.
        skipWake.current = false;
        emit({ type: "files-loaded", tableCount });
      } else {
        emit({ type: "wake" });
      }
    } else if (prev > 0 && tableCount === 0) {
      if (quietRef?.current) {
        skipWake.current = true;
      } else {
        skipWake.current = false;
        emit({ type: "reset" });
      }
    } else if (prev > 0 && tableCount > prev) {
      emit({ type: "files-loaded", tableCount });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableCount]);

  // 2. The stitch screen opening: proposals are shown.
  const prevOpen = useRef(stitchOpen);
  useEffect(() => {
    if (!prevOpen.current && stitchOpen) emit({ type: "stitch-open" });
    prevOpen.current = stitchOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stitchOpen]);

  // 3. The AI switch turned off.
  const prevAi = useRef(aiOn);
  useEffect(() => {
    if (prevAi.current && !aiOn) emit({ type: "ai-off" });
    prevAi.current = aiOn;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOn]);

  // 4. The stitch store: decisions, confirm, stitched, undo, fan-out.
  useEffect(() => {
    let prev: StitchState = stitchStore.getState();
    let approved = 0;
    let rejected = 0;
    let flushing = false;
    const flush = () => {
      flushing = false;
      const a = approved;
      const r = rejected;
      approved = 0;
      rejected = 0;
      if (a >= 2) emit({ type: "approve-all" });
      else if (a === 1) emit({ type: "approve" });
      else if (r > 0) emit({ type: "reject" });
    };
    const unsubscribe = stitchStore.subscribe(() => {
      const next = stitchStore.getState();
      const before = prev;
      prev = next;
      if (resettingRef.current) return;
      if (next.decisions !== before.decisions) {
        for (const [id, d] of Object.entries(next.decisions)) {
          const old = before.decisions[id];
          if (old?.decision === d.decision) continue;
          if (d.decision === "approved" || d.decision === "edited") approved += 1;
          else if (d.decision === "rejected") rejected += 1;
        }
        if ((approved > 0 || rejected > 0) && !flushing) {
          flushing = true;
          // One user click can set many decisions: count them in one tick.
          queueMicrotask(flush);
        }
      }
      if (before.plan === null && next.plan !== null) emit({ type: "confirm-stitch" });
      if (before.stitchedTable === null && next.stitchedTable !== null) {
        emit({ type: "stitch-applied" });
      } else if (before.stitchedTable !== null && next.stitchedTable === null && tableCountRef.current > 0) {
        emit({ type: "undo-stitch" });
      }
      if (before.fanOut?.fannedOut !== true && next.fanOut?.fannedOut === true) {
        emit({ type: "fan-out" });
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stitchStore]);

  // 5. The ask store: a question that failed.
  useEffect(() => {
    let prev: AskState = askStore.getState();
    const unsubscribe = askStore.subscribe(() => {
      const next = askStore.getState();
      const before = prev;
      prev = next;
      if (before.loading && !next.loading && next.outcome?.kind === "error") {
        emit({ type: "ask-error" });
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askStore]);

  // 6. Things no store records: Autopsy score and "Fix all", recipes, export.
  useEffect(() => frankBus.subscribe((event) => emit(event)), []); // eslint-disable-line react-hooks/exhaustive-deps
}
