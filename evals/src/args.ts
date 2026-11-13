import { parseArgs, type ParseArgsConfig } from "node:util";
import { pathToFileURL } from "node:url";

/** True when this module is the script tsx was asked to run. */
export function isMain(metaUrl: string): boolean {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

export function cli<T extends NonNullable<ParseArgsConfig["options"]>>(options: T, usage: string, argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs({ args: argv, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
    if ((parsed.values as Record<string, unknown>).help) {
      console.log(usage);
      process.exit(0);
    }
    return parsed;
  } catch (err) {
    console.error((err as Error).message + "\n\n" + usage);
    process.exit(2);
  }
}

export function list(value: string | undefined): string[] {
  return value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];
}

export async function main(run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
