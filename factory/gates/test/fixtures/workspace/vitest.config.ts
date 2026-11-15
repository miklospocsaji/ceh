import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{app,factory}/*/test/**/*.test.ts"],
  },
});
