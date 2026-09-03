#!/usr/bin/env node
// Runs `node --test` against explicit *.test.js files only.
//
// IMPORTANT: never pass a directory to `node --test` (e.g. `node --test dist`).
// Node's test runner will `require()` every .js file under that directory as
// a candidate test module, including non-test files like the CLI entrypoint
// and scripts under dist/scripts/. Those files guard their side effects with
// `require.main === module`, but that guard does NOT help here: `node --test`
// spawns each matched file as its own child process, so `require.main`
// equals `module` there too. The only real protections are (1) always
// listing explicit *.test.js files/globs here, never a directory, and
// (2) migrations defaulting to dry-run (see README "Safety" section).
//
// This script also fails loudly if zero test files are found, since
// `find ... | xargs node --test` would otherwise silently "pass" 0 tests.
const { execFileSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "dist");

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.endsWith(".test.js")) {
      results.push(full);
    }
  }
  return results;
}

const testFiles = findTestFiles(root);

if (testFiles.length === 0) {
  console.error(
    "No *.test.js files found under dist/. Refusing to silently report success."
  );
  process.exit(1);
}

console.error(`Running ${testFiles.length} test file(s):`);
for (const file of testFiles) {
  console.error(`  ${path.relative(root, file)}`);
}

execFileSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});
