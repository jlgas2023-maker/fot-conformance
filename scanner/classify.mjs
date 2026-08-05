// Combines static + dynamic check results into one verdict: clean,
// declared_fot, or suspect. A plain rule-based classifier, not a score --
// matching the project brief's "never output a bare score" requirement,
// the RULE itself is documented here so the verdict is reproducible by
// re-reading this function against the same checks array, not just by
// trusting a number.
//
// Validated against exactly one real fixture (TACO -> declared_fot, every
// individual check confirmed correct against the actual contract source
// during development, see scanner/README.md). A genuine `suspect` fixture
// is still needed to validate that side of this classifier -- see
// scanner/README.md's fixture note for why one wasn't fabricated.

export function classify(checks) {
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  const get = (id) => byId[id]?.result;

  // Any of these true is an immediate suspect signal -- each is either
  // the documented drainer pattern itself or a mechanism that could
  // silently disable/redirect the tax after launch.
  const suspectSignals = [
    ["non_allowance_mapping_read", get("non_allowance_mapping_read") === true],
    ["allowance_bypass", get("allowance_bypass") === true],
    ["privileged_address_check", get("privileged_address_check") === true],
    ["mint_function_with_live_owner", get("mint_function") === true && get("owner_is_zero") === false],
    ["blacklist_function_with_live_owner", get("blacklist_function") === true && get("owner_is_zero") === false],
    ["pause_function_with_live_owner", get("pause_function") === true && get("owner_is_zero") === false],
    ["mutable_fee_rate_with_live_owner", get("fee_rate_mutability") === "mutable_with_setter" && get("owner_is_zero") === false],
    // A sell that reverts while a buy succeeds is the honeypot signature
    // this whole project exists to catch.
    ["sell_blocked_but_buy_ok", get("sim_buy") === true && get("sim_sell") === false],
  ];
  const triggeredSuspect = suspectSignals.filter(([, triggered]) => triggered);
  if (triggeredSuspect.length > 0) {
    return { verdict: "suspect", reason: triggeredSuspect.map(([id]) => id) };
  }

  if (get("fee_logic_present") !== true) {
    return { verdict: "clean", reason: ["no_fee_logic_detected"] };
  }

  // Fee logic exists and none of the suspect signals fired -- a declared,
  // (so far as this scanner can tell) honestly-implemented FOT token.
  return { verdict: "declared_fot", reason: ["fee_logic_present_no_suspect_signals"] };
}
