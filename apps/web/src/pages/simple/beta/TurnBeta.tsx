import type { ComponentProps } from "react";
import { Turn as SharedTurn, type TurnBeta } from "../Turn";
import { PassSummary, ThreadResult } from "./PassSummaryBeta";

const lists: TurnBeta = { PassSummary, ThreadResult };

/** One thread's requests in the new layout (`Turn`), with its edits listed in the column of edits. */
export function Turn(props: Omit<ComponentProps<typeof SharedTurn>, "beta" | "laterRequests" | "pinHost"> & { pinHost: HTMLElement | null }) {
  return <SharedTurn {...props} beta={lists} />;
}
