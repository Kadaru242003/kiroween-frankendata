/**
 * FrankRegion: wires Little Frank to the app. It reads the stores and props the
 * app already has, turns changes into Frank events (`useFrankEvents`), keeps the
 * reaction queue (`useFrankController`) and renders the mascot (`Specimen`) with
 * the "Ask Little Frank" guide as its child. Read-only: it changes no app state.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { contextTip } from "../../core/frank/guide";
import type { StitchStore } from "../../core/stitching/stitch-store";
import type { StitchedTable } from "../../core/stitching/types";
import { useStitchStore } from "../../core/stitching/stitch-store";
import type { AskStore } from "../../state/ask-store";
import { useAskStore } from "../../state/ask-store";
import { Specimen, isAskResultShown } from "../Specimen";
import { frankFeed } from "../../state/frank-feed";
import { useReducedMotion } from "./useReducedMotion";
import { FrankGuide } from "./FrankGuide";
import { useFrankController, type FrankControllerOptions } from "./useFrankController";
import { useFrankEvents } from "./useFrankEvents";

export interface FrankRegionProps {
  /** The stitch that was current when a recipe was applied (scroll pose while it holds). */
  recipeBase: { stitched: StitchedTable | null } | null;
  autopsyOpen: boolean;
  tableCount: number;
  intakeError: boolean;
  stitchStore: StitchStore;
  askStore: AskStore;
  aiOn: boolean;
  stitchOpen: boolean;
  resetting: boolean;
  quietResetRef?: { current: boolean };
  /** Tests shorten the idle time. */
  controller?: FrankControllerOptions;
}

export function FrankRegion(props: FrankRegionProps): JSX.Element {
  const { stitchStore, askStore, tableCount } = props;
  const stitch = useStitchStore(stitchStore);
  const ask = useAskStore(askStore);
  const reduced = useReducedMotion();
  const frank = useFrankController({ quipsEnabled: tableCount > 0, ...props.controller });
  const [guideOpen, setGuideOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Tell anything decorative that moves with him (the lab shelf) what he is doing.
  useEffect(() => {
    frankFeed.publish({ reaction: frank.reaction, seq: frank.reactionSeq, calm: frank.calm });
  }, [frank.reaction, frank.reactionSeq, frank.calm]);

  useFrankEvents({
    emit: frank.emit,
    tableCount,
    stitchStore,
    askStore,
    aiOn: props.aiOn,
    stitchOpen: props.stitchOpen,
    autopsyOpen: props.autopsyOpen,
    resetting: props.resetting,
    quietResetRef: props.quietResetRef,
  });

  // Held-pose props, derived from existing state (as before).
  const proposals = stitch.proposals;
  const proposalsShowing =
    proposals !== null && (proposals.matches.length > 0 || proposals.cleanings.length > 0);
  let approvedCount = 0;
  for (const decision of Object.values(stitch.decisions)) {
    if (decision.decision === "approved" || decision.decision === "edited") approvedCount += 1;
  }
  const stitched = stitch.stitchedTable !== null;

  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, []);
  const toggleGuide = useCallback(() => setGuideOpen((open) => !open), []);

  // Closing him with Reset lab or an empty lab keeps the guide usable: no change.
  const tip = contextTip({ tableCount, proposalsPending: proposalsShowing && !stitched, stitched });

  return (
    <Specimen
      tableCount={tableCount}
      autopsyOpen={props.autopsyOpen}
      recipeApplied={props.recipeBase !== null && stitch.stitchedTable === props.recipeBase.stitched}
      proposalsShowing={proposalsShowing}
      approvedCount={approvedCount}
      stitched={stitched}
      askPending={ask.loading}
      askResult={isAskResultShown(ask.outcome, ask.loading)}
      intakeError={props.intakeError}
      reaction={frank.reaction}
      reactionSeq={frank.reactionSeq}
      bubble={frank.bubble}
      idle={frank.idle}
      calm={frank.calm}
      reducedMotion={reduced}
      guideOpen={guideOpen}
      onPoke={() => frank.poke(tableCount > 0)}
      onToggleGuide={toggleGuide}
      buttonRef={buttonRef}
    >
      <FrankGuide
        open={guideOpen}
        onClose={closeGuide}
        tip={tip}
        calm={frank.calm}
        onCalmChange={frank.setCalm}
        instant={reduced || frank.calm}
        toggleRef={buttonRef}
      />
    </Specimen>
  );
}

export default FrankRegion;
