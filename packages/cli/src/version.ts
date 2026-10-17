/** This package's version, which build.mjs defines; `dev` outside the bundle. */
declare const __PITSTOP_VERSION__: string | undefined;

export const VERSION: string = typeof __PITSTOP_VERSION__ !== "undefined" ? __PITSTOP_VERSION__ : "dev";

/** True for `--help`, `-h` or `--version`: the bins answer those with a line instead of starting. */
export const asksForHelp = (argv: string[]): boolean => argv.some((a) => a === "--help" || a === "-h" || a === "--version");
