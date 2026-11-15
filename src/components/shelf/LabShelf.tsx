/**
 * The lab shelf: a decorative shelf in the empty right gutter, shown only when
 * the viewport is at least SHELF_MIN_WIDTH_PX wide (below that it is not
 * rendered at all). It is fixed beside the main column, so it never shifts it.
 *
 * It holds no state of its own about the lab. It reads what the app already has
 * (the loaded tables and the stitch store) and what Little Frank is doing (the
 * Frank feed): a Tesla coil that powers up, arcs on his wake strike and sparks
 * on Confirm & stitch, and one specimen jar per table. Jars are buttons that
 * scroll their table's card into view; everything else is aria-hidden and
 * ignores the pointer.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import {
  SHELF_MIN_WIDTH_PX,
  buildJars,
  nextCrackleDelayMs,
  type Jar,
} from "../../core/shelf/shelf-model";
import { useStitchStore, type StitchStore } from "../../core/stitching/stitch-store";
import type { LoadedTable } from "../../core/types";
import { frankFeed } from "../../state/frank-feed";
import { useReducedMotion } from "../frank/useReducedMotion";
import { SpecimenJar } from "./SpecimenJar";
import { TeslaCoil } from "./TeslaCoil";
import "./LabShelf.css";

/** How long a draining jar stays: the liquid falls, then it fades. */
export const JAR_LEAVE_MS = 1000;

function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

interface Rendered {
  jar: Jar;
  leaving: boolean;
}

/** Jars that disappear stay for a moment to drain and fade (not under reduced motion or Calm). */
function useJarLifecycle(jars: Jar[], still: boolean): Rendered[] {
  const [leaving, setLeaving] = useState<{ jar: Jar; index: number }[]>([]);
  const prevRef = useRef<Jar[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = jars;
    if (still) {
      setLeaving((l) => (l.length === 0 ? l : []));
      return;
    }
    const keys = new Set(jars.map((j) => j.key));
    const gone = prev
      .map((jar, index) => ({ jar, index }))
      .filter((x) => x.jar.kind !== "more" && !keys.has(x.jar.key));
    if (gone.length === 0) return;
    setLeaving((l) => [...l.filter((x) => !keys.has(x.jar.key)), ...gone]);
    timers.current.push(
      setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), JAR_LEAVE_MS)
    );
  }, [jars, still]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    []
  );

  const keys = new Set(jars.map((j) => j.key));
  const out: Rendered[] = jars.map((jar) => ({ jar, leaving: false }));
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) {
    if (keys.has(l.jar.key)) continue;
    out.splice(Math.min(l.index, out.length), 0, { jar: l.jar, leaving: true });
  }
  return out;
}

export interface LabShelfProps {
  /** The loaded tables (the same list the table cards come from). */
  tables: readonly LoadedTable[];
  stitchStore: StitchStore;
  /** Override for tests. */
  minWidth?: number;
}

export function LabShelf({ tables, stitchStore, minWidth = SHELF_MIN_WIDTH_PX }: LabShelfProps): JSX.Element | null {
  const wide = useMinWidth(minWidth);
  const { stitchedTable } = useStitchStore(stitchStore);
  const feed = useSyncExternalStore(frankFeed.subscribe, frankFeed.getSnapshot, frankFeed.getSnapshot);
  const reduced = useReducedMotion();
  const still = reduced || feed.calm;
  const powered = tables.length > 0;

  const jars = useMemo(
    () =>
      buildJars(
        tables.map((t) => ({ tableName: t.tableName, rowCount: t.rowCount })),
        stitchedTable === null ? null : { tableName: stitchedTable.tableName, rowCount: stitchedTable.rowCount }
      ),
    [tables, stitchedTable]
  );
  const rendered = useJarLifecycle(jars, still || !wide);

  // Idle crackle: faint, and never more often than every 20 seconds.
  const [crackleSeq, setCrackleSeq] = useState(0);
  useEffect(() => {
    if (!wide || !powered || still) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setCrackleSeq((n) => n + 1);
        schedule();
      }, nextCrackleDelayMs(Math.random()));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [wide, powered, still]);

  if (!wide) return null;

  // The coil follows Frank's reactions: the big arc with the wake strike, a
  // small spark with the stitch being confirmed (his "sew").
  const wakeSeq = feed.reaction?.id === "wake" ? feed.seq : 0;
  const sparkSeq = feed.reaction?.id === "sew" ? feed.seq : 0;

  const goTo = (name: string) => {
    const cards = document.querySelectorAll<HTMLElement>("section.table-preview-card");
    for (const card of cards) {
      if (card.getAttribute("aria-label") === `Preview of ${name}`) {
        card.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        return;
      }
    }
  };

  return (
    <aside className={`lab-shelf${still ? " lab-shelf--still" : ""}`} data-testid="lab-shelf" aria-label="Lab shelf">
      <TeslaCoil powered={powered} still={still} crackleSeq={crackleSeq} wakeSeq={wakeSeq} sparkSeq={sparkSeq} />
      <div className="lab-shelf__jars">
        {rendered.map(({ jar, leaving }) => (
          <SpecimenJar key={jar.key} jar={jar} leaving={leaving} still={still} onGo={goTo} />
        ))}
      </div>
    </aside>
  );
}

export default LabShelf;
