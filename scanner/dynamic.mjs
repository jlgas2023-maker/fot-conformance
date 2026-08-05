// FOT taxonomy scanner -- dynamic (eth_call simulation) half. NOT YET
// IMPLEMENTED. See README.md for the full check list.
//
// Hard constraint reminder (see docs/methodology.md): eth_call simulation
// ONLY. Nothing here may broadcast a real transaction -- every simulated
// buy/sell/transfer uses eth_call with a `from` override (state override
// set, RPC-dependent support) or a local fork/trace, never
// eth_sendRawTransaction or a signed tx of any kind.
//
// Planned approach:
//   1. simulateBuy/simulateSell/simulateTransfer: eth_call the router's
//      swap function (or plain transferFrom for wallet-to-wallet) from a
//      throwaway address with a state override giving it balance --
//      compare the resulting balance delta to the pre-fee expected
//      amount computed from reserves, same math as
//      dashboard's/stats.html's tacoPrice().
//   2. simulateSellFromExistingHolder: same as simulateSell but the
//      override pre-seeds the caller's token balance BEFORE the swap
//      call, to catch a drainer that only blocks sells for wallets that
//      already hold the token (a buy-then-sell probe in two separate
//      calls would miss a contract that specifically checks "has this
//      address ever received a transfer before").
//   3. routerCompatibility: eth_call
//      swapExactTokensForETHSupportingFeeOnTransferTokens AND the
//      non-supporting swapExactTokensForETH variant, report which
//      succeeds/reverts and the revert reason if decodable.

/**
 * @param {{address: string, pool: string}} tokenCfg
 * @param {object} chainCfg
 * @returns {Promise<Array<import('./verdict.schema.json')>>} one entry per
 *   dynamic check, kind: "dynamic"
 */
export async function runDynamicChecks(tokenCfg, chainCfg) {
  throw new Error(
    "scanner/dynamic.mjs not implemented -- see README.md's Planned checks section."
  );
}
