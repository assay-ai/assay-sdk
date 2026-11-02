import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// A client without a `channels` option keeps its lanes under the user's config folder: point the
// home folder of the test workers at a fresh temporary one, never the real one.
const home = mkdtempSync(join(tmpdir(), "goassay-sdk-test-home-"));

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { HOME: home, USERPROFILE: home } },
});
