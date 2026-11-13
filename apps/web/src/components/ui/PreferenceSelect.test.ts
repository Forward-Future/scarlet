import { expect, it } from "vitest";

it("keeps native dropdowns out of the desktop renderer", () => {
  const sources = import.meta.glob<string>(["/src/**/*.{tsx,jsx}", "!**/*.test.*"], { eager: true, query: "?raw", import: "default" });
  const nativeSelects = Object.entries(sources).filter(([, source]) => /<select\b/.test(source));
  expect(nativeSelects.map(([file]) => file)).toEqual([]);
});
