#!/usr/bin/env node
// Chain infrastructure QA monitor -- Deliverable 4. NOT YET IMPLEMENTED.
// See README.md for the planned checks. Intended shape, once built:
//
//   node chainqa/check.mjs
//     -> writes chainqa/history/<ISO-timestamp>.json (mirrors supply/
//        check.mjs's pattern exactly: dated + immutable, index.json
//        manifest alongside it) with:
//          { rpcLatencyMs, rpcOk, indexingLagBlocks,
//            routerCompatibility: [...], verificationCoveragePct }
//
// Left as a throwing stub rather than a fake "everything's fine" result --
// an unimplemented check must never silently read as a passing one.

async function main() {
  throw new Error(
    "chainqa/check.mjs not implemented -- see README.md. Build after scanner/ " +
      "per the documented build order (this depends on scheduling infrastructure " +
      "supply/check.mjs's Action already establishes, not on scanner/, but scanner/ " +
      "is still the harder/more valuable deliverable to build first)."
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
