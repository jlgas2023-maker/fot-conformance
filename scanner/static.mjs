// FOT taxonomy scanner -- static analysis half. NOT YET IMPLEMENTED. See
// README.md for the full check list and rationale; this file exists to
// pin the function signature/shape so dynamic.mjs and index.mjs (also
// stubs) have something concrete to import against once this is built.
//
// Planned approach, in order:
//   1. Fetch verified source from {chainCfg.explorerApiBase}/api/v2/smart-contracts/{address}
//      (Blockscout's verified-source endpoint -- confirmed shape not yet
//      checked live for this chain, do that first).
//   2. If verified: parse for _transfer/transfer/transferFrom, classify
//      fee-rate storage (constant/immutable vs mutable+setter) from the
//      AST/source text, not just regex -- a mutable var named `feeRate`
//      that's never actually written after construction is functionally
//      immutable and regex would misclassify it.
//   3. If NOT verified: fall back to deployed bytecode analysis (opcode
//      scan for SLOAD patterns inside the transfer selector's jump
//      target) -- lower confidence, must be labeled as such in the
//      verdict, never silently treated as equivalent to a source-based
//      check.
//   4. Every finding cites evidence (opcode offset or source line) per
//      verdict.schema.json -- no check may report a result with a null
//      evidence object.

/**
 * @param {{address: string}} tokenCfg
 * @param {object} chainCfg
 * @returns {Promise<Array<import('./verdict.schema.json')>>} one entry per
 *   static check, kind: "static"
 */
export async function runStaticChecks(tokenCfg, chainCfg) {
  throw new Error(
    "scanner/static.mjs not implemented -- see README.md's Planned checks section. " +
      "This is Deliverable 1, explicitly the hardest one per the build order; do not " +
      "stub a fake passing result here, that would be worse than an explicit error."
  );
}
