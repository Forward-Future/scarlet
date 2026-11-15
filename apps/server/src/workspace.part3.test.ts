// Part 3 of the tests in workspace.test.ts, so a full run spreads that long file over several workers.
import { runPart, startPart } from "../../../test/parts";

startPart(2, 4);
await import("./workspace.test.js");
runPart();
