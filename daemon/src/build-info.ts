/**
 * What packages/cli's esbuild bundle tells the code it bundles (its `define`). From source or from
 * dist/ neither constant exists, and `typeof` keeps the check safe.
 */
declare const __PITSTOP_BUNDLE__: boolean | undefined;
declare const __PITSTOP_VERSION__: string | undefined;

/**
 * True inside the bundle. There every module shares the bundle's file, so a module's own
 * "am I the script node was started with?" check would fire for whichever module asks: the bundle's
 * entry files run things instead.
 */
export const BUNDLED: boolean = typeof __PITSTOP_BUNDLE__ !== "undefined" && __PITSTOP_BUNDLE__ === true;

/** pitstop-cli's version in the bundle, `dev` from source. */
export const VERSION: string = typeof __PITSTOP_VERSION__ !== "undefined" ? __PITSTOP_VERSION__ : "dev";
