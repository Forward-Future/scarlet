// @vitest-environment happy-dom
// Part 6 of the tests in SimpleWorkspace.test.tsx, so a full run spreads that long file over several workers.
import { runPart, startPart } from "../../../../test/parts";

startPart(5, 8);
await import("./SimpleWorkspace.test");
runPart();
