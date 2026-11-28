// Runs every RuleTester suite in the pack under node:test. RuleTester needs Node 22+, not Bun.
// Usage: node --test-reporter=dot <pack>/test.ts
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

RuleTester.describe = describe;
RuleTester.it = it;

const root = new URL(".", import.meta.url);
const suites = readdirSync(root, { recursive: true, encoding: "utf8" })
  // The upstream CLI suite shells out to pnpm; the RuleTester suites cover the same rules.
  .filter((path) => path.endsWith(".test.ts") && !path.endsWith("-cli.test.ts"))
  .sort();

for (const suite of suites) await import(new URL(suite, root).href);
