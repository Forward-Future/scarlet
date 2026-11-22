/**
 * Source-anchored time mapping, content diffs, and rebasing.
 *
 * Timeline times shift every time something earlier in the cut is trimmed or
 * extended, so "12.4 s" means different things in different versions. A moment
 * in the *source footage* ("14.2 s into interview.mp4") does not move. These
 * helpers translate times between two versions through the footage, which lets
 * Scarlet:
 *
 *  - find what visibly changed between two versions (short, accurate change
 *    clips even when a cut shifts everything after it),
 *  - re-apply an agent's edits onto a cut that moved since the agent started
 *    (parallel threads), and refuse when the edits overlap,
 *  - apply only some spots of a batch ("keep 5 of these 6 cuts").
 */
export { makeTimeMap, removedJoins, sameContent, type TimeMap } from "./timeMap.js";
export { changedSpots, indexClipsAt, rangesOverlapWithin, type ChangedSpot } from "./changedSpots.js";
export { RebaseConflict, rebaseOp, replayOps } from "./replayOps.js";
export { assignSpots, canApproveSpots, independentClipSpots, independentCutSpots, planApply, type ApplyPlan } from "./spotAssign.js";
