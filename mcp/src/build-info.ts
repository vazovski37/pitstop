/**
 * True inside packages/cli's esbuild bundle, which defines the constant; from source or dist/ it
 * does not exist and `typeof` keeps the check safe. In the bundle every module shares the bundle's
 * file, so a module's own "am I the script node was started with?" check would fire there: the
 * bundle's entry files start things instead (daemon/src/build-info.ts says the same).
 */
declare const __PITSTOP_BUNDLE__: boolean | undefined;

export const BUNDLED: boolean = typeof __PITSTOP_BUNDLE__ !== "undefined" && __PITSTOP_BUNDLE__ === true;
