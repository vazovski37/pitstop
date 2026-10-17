import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Tests import the protocol from source, so no build step is needed first.
      "@pitstop/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["**/src/**/*.test.ts"],
    // .claude/worktrees holds other Claude sessions' checkouts of this repository: their tests are not ours.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
