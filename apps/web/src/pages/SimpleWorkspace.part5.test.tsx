// @vitest-environment happy-dom
// Part 5 of the tests in SimpleWorkspace.test.tsx, so a full run spreads that long file over several workers.
import { runPart, startPart } from "../../../../test/parts";

startPart(4, 8);
await import("./SimpleWorkspace.test");
runPart();
