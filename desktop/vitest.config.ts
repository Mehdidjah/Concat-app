import { defineConfig } from "vitest/config";

// Node is the default: the lib/ tests are pure logic and need no DOM.
// Component tests opt into a browser-like environment per file with a
// `// @vitest-environment jsdom` docblock at the top.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
