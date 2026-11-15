/**
 * The lab shelf: page navigation drawn as a Tesla coil over a row of specimen
 * jars, in the empty right gutter. It is shown only when the viewport is at
 * least SHELF_MIN_WIDTH_PX wide (below that it is not rendered at all) and is
 * fixed beside the 1200px main column, so it never shifts it.
 *
 *  - One jar per page section, shown only while that section exists, in
 *    workflow order (`shelf-model.ts`). Its liquid shows how far the step has got.
 *  - Clicking a jar (or Enter or Space) scrolls that section into view, smoothly
 *    (at once under reduced motion), and moves keyboard focus to its heading.
 *  - The jar of the section in view is highlighted (`aria-current`), found with
 *    an IntersectionObserver on the sections' `data-lab-section` markers.
 *  - The coil follows Little Frank through the Frank feed: a big arc on his wake
 *    strike, a small spark on Confirm & stitch, static dancing while he is alive.
 *
 * It holds no state about the lab that the app does not already have. The page
 * sections it points at carry `data-lab-section` markers; nothing else moves.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
} from "react";
import {
  SHELF_MIN_SCALE,
  SHELF_MIN_WIDTH_PX,
  buildSectionJars,
  nextCrackleDelayMs,
  pickActiveSection,
  type SectionId,
  type SectionJar as SectionJarModel,
  type ShelfInput,
} from "../../core/shelf/shelf-model";
import { useStitchStore, type StitchStore } from "../../core/stitching/stitch-store";
import type { LoadedTable } from "../../core/types";
import { useAskStore, type AskStore } from "../../state/ask-store";
import { frankBus } from "../../state/frank-bus";
import { frankFeed } from "../../state/frank-feed";
import { useReducedMotion } from "../frank/useReducedMotion";
import { SectionJar } from "./SectionJar";
import { TeslaCoil } from "./TeslaCoil";
import "./LabShelf.css";

/** How long a draining jar stays: the liquid falls, then it fades. */
export const JAR_LEAVE_MS = 1000;

/** The sections whose heading is not a good focus target: focus the section itself. */
const FOCUS_CONTAINER: ReadonlySet<SectionId> = new Set<SectionId>(["intake", "tables"]);

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
  jar: SectionJarModel;
  leaving: boolean;
}

/** Jars whose section went away stay a moment to drain and fade (not under reduced motion or Calm). */
function useJarLifecycle(jars: SectionJarModel[], still: boolean): Rendered[] {
  const [leaving, setLeaving] = useState<{ jar: SectionJarModel; index: number }[]>([]);
  const prevRef = useRef<SectionJarModel[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = jars;
    if (still) {
      setLeaving((l) => (l.length === 0 ? l : []));
      return;
    }
    const ids = new Set(jars.map((j) => j.id));
    const gone = prev.map((jar, index) => ({ jar, index })).filter((x) => !ids.has(x.jar.id));
    if (gone.length === 0) return;
    setLeaving((l) => [...l.filter((x) => !ids.has(x.jar.id)), ...gone]);
    timers.current.push(setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), JAR_LEAVE_MS));
  }, [jars, still]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    []
  );

  const ids = new Set(jars.map((j) => j.id));
  const out: Rendered[] = jars.map((jar) => ({ jar, leaving: false }));
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) {
    if (ids.has(l.jar.id)) continue;
    out.splice(Math.min(l.index, out.length), 0, { jar: l.jar, leaving: true });
  }
  return out;
}

/** Keys that scroll the page by hand. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

/**
 * The section crossing the middle of the window, found with an
 * IntersectionObserver. A jar you just clicked stays current (the page cannot
 * always put a short section at the middle) until you scroll by hand.
 */
function useActiveSection(
  ids: SectionId[],
  enabled: boolean
): { active: SectionId | null; pin: (id: SectionId) => void } {
  const [seen, setActive] = useState<SectionId | null>(null);
  const [pinned, setPinned] = useState<SectionId | null>(null);
  useEffect(() => {
    if (pinned === null) return;
    const release = () => setPinned(null);
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) setPinned(null);
    };
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchmove", release, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchmove", release);
      window.removeEventListener("keydown", onKey);
    };
  }, [pinned]);
  const key = ids.join(",");
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const wanted = key === "" ? [] : (key.split(",") as SectionId[]);
    const crossing = new Set<SectionId>();
    const observed = new Map<SectionId, Element>();
    const domOrder = () =>
      [...observed.entries()]
        .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .map(([id]) => id);
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.labSection as SectionId | undefined;
          if (id === undefined) continue;
          if (entry.isIntersecting) crossing.add(id);
          else crossing.delete(id);
        }
        const next = pickActiveSection([...crossing], domOrder());
        setActive((prev) => next ?? prev);
      },
      // A thin band across the middle of the window: "in view" means "being read".
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
    );
    // Sections mount and unmount on their own schedule, so keep the observed set in sync.
    const sync = () => {
      for (const id of wanted) {
        const el = document.querySelector(`[data-lab-section="${id}"]`);
        const old = observed.get(id);
        if (el === old) continue;
        if (old) {
          io.unobserve(old);
          crossing.delete(id);
        }
        if (el) {
          io.observe(el);
          observed.set(id, el);
        } else {
          observed.delete(id);
        }
      }
      for (const [id, el] of [...observed]) {
        if (!wanted.includes(id)) {
          io.unobserve(el);
          observed.delete(id);
          crossing.delete(id);
        }
      }
    };
    sync();
    let raf = 0;
    const page = document.getElementById("lab");
    const mutations =
      page === null || typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (raf === 0) {
              raf = requestAnimationFrame(() => {
                raf = 0;
                sync();
              });
            }
          });
    mutations?.observe(page!, { childList: true, subtree: true });
    return () => {
      mutations?.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [key, enabled]);
  const current = pinned !== null && ids.includes(pinned) ? pinned : seen;
  return {
    active: enabled && current !== null && ids.includes(current) ? current : null,
    pin: setPinned,
  };
}

export interface LabShelfProps {
  /** The loaded tables (the same list the table cards come from). */
  tables: readonly LoadedTable[];
  stitchStore: StitchStore;
  askStore: AskStore;
  /** The stitching table is open on the page. */
  stitchOpen: boolean;
  /** The table whose Autopsy is open, or null. */
  autopsyTableName: string | null;
  /** Override for tests. */
  minWidth?: number;
}

export function LabShelf({
  tables,
  stitchStore,
  askStore,
  stitchOpen,
  autopsyTableName,
  minWidth = SHELF_MIN_WIDTH_PX,
}: LabShelfProps): JSX.Element | null {
  const wide = useMinWidth(minWidth);
  const stitch = useStitchStore(stitchStore);
  const ask = useAskStore(askStore);
  const feed = useSyncExternalStore(frankFeed.subscribe, frankFeed.getSnapshot, frankFeed.getSnapshot);
  const reduced = useReducedMotion();
  const still = reduced || feed.calm;
  const powered = tables.length > 0;
  const alive = powered && !feed.idle;

  // Progress that no store records: a recipe saved or applied, and the Autopsy score.
  const [recipeDone, setRecipeDone] = useState(false);
  const [autopsyScore, setAutopsyScore] = useState<number | null>(null);
  useEffect(
    () =>
      frankBus.subscribe((event) => {
        if (event.type === "save-recipe" || event.type === "apply-recipe") setRecipeDone(true);
        else if (event.type === "autopsy" && Number.isFinite(event.score)) {
          setAutopsyScore(Math.round(event.score));
        }
      }),
    []
  );
  const [askAnswered, setAskAnswered] = useState(false);
  useEffect(() => {
    if (tables.length === 0) {
      setRecipeDone(false);
      setAskAnswered(false);
    } else if (!ask.loading && ask.outcome?.kind === "ok") {
      setAskAnswered(true);
    }
  }, [tables.length, ask.loading, ask.outcome]);
  useEffect(() => {
    // A new (or closed) Autopsy starts without a score until its report is done.
    setAutopsyScore(null);
  }, [autopsyTableName]);

  const input = useMemo<ShelfInput>(() => {
    const proposals = stitch.proposals;
    const total = proposals === null ? 0 : proposals.matches.length + proposals.cleanings.length;
    const approved = Object.values(stitch.decisions).filter(
      (d) => d.decision === "approved" || d.decision === "edited"
    ).length;
    return {
      tables: tables.map((t) => ({ tableName: t.tableName, rowCount: t.rowCount })),
      stitchOpen,
      proposals: proposals === null ? null : { total, approved: Math.min(total, approved) },
      stitched:
        stitch.stitchedTable === null
          ? null
          : { tableName: stitch.stitchedTable.tableName, rowCount: stitch.stitchedTable.rowCount },
      recipeDone,
      autopsy:
        autopsyTableName === null
          ? null
          : { tableName: autopsyTableName, score: autopsyScore },
      ask: { answered: askAnswered, loading: ask.loading },
    };
  }, [tables, stitchOpen, stitch, recipeDone, autopsyTableName, autopsyScore, askAnswered, ask.loading]);
  const jars = useMemo(() => buildSectionJars(input), [input]);
  const rendered = useJarLifecycle(jars, still || !wide);
  const { active, pin } = useActiveSection(
    jars.map((j) => j.id),
    wide
  );

  // Scale the shelf down (never below SHELF_MIN_SCALE) when it does not fit the window.
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!wide || el === null) return;
    const fit = () => {
      const natural = el.offsetHeight;
      const room = window.innerHeight - 24;
      const next = natural > 0 ? Math.min(1, Math.max(SHELF_MIN_SCALE, room / natural)) : 1;
      setScale((prev) => (Math.abs(prev - next) < 0.005 ? prev : next));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [wide, rendered.length]);

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

  const wakeSeq = feed.reaction?.id === "wake" ? feed.seq : 0;
  const sparkSeq = feed.reaction?.id === "sew" ? feed.seq : 0;

  const goTo = (id: SectionId) => {
    const section = document.querySelector<HTMLElement>(`[data-lab-section="${id}"]`);
    if (section === null) return;
    pin(id);
    section.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    // Keyboard focus follows to the section's heading (or the section itself when it has none).
    const heading = FOCUS_CONTAINER.has(id) ? null : section.querySelector<HTMLElement>("h1, h2, h3");
    const target = heading ?? section;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  };

  return (
    <nav
      className={`lab-shelf${still ? " lab-shelf--still" : ""}`}
      aria-label="Lab sections"
      data-testid="lab-shelf"
      style={{ "--shelf-scale": scale } as CSSProperties}
    >
      <div className="lab-shelf__inner" ref={innerRef}>
        <TeslaCoil
          powered={powered}
          alive={alive}
          still={still}
          crackleSeq={crackleSeq}
          wakeSeq={wakeSeq}
          sparkSeq={sparkSeq}
        />
        <ul className="lab-shelf__list">
          {rendered.map(({ jar, leaving }) => (
            <SectionJar key={jar.id} jar={jar} active={active === jar.id} leaving={leaving} still={still} onGo={goTo} />
          ))}
        </ul>
      </div>
    </nav>
  );
}

export default LabShelf;
