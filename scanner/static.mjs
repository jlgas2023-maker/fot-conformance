// FOT taxonomy scanner -- static analysis half. Fetches verified Solidity
// source from Blockscout and runs REGEX/TEXT-BASED heuristics against it,
// not a full AST parse. See scanner/README.md's "Known limitation"
// section for exactly what that tradeoff means and why -- this is a v1
// validated against exactly one real fixture (TACO), not a general-purpose
// Solidity static analyzer. Every check's evidence includes the matched
// source text so a human (or another tool) can verify the finding
// directly, which matters more for a heuristic approach than for a
// compiler-grade one.
//
// A contract with NO verified source gets `verified: false` and every
// check below returns result: null with an explicit "not verified"
// evidence note -- never a fabricated "clean" result for something this
// scanner literally could not examine.

const FUNCTION_NAMES = ["_transfer", "transfer", "transferFrom", "_xfer", "_update"];

function fetchSource(chainCfg, address) {
  const url = `${chainCfg.explorerApiBase}/api/v2/smart-contracts/${address}`;
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// Naive brace-matched function-body extractor -- finds `function <name>(...)
// { ... }` and returns the body text between the FIRST top-level `{` and
// its matching `}` (brace-depth counted, so nested blocks don't truncate
// it early). Works for the straightforward single-file contracts this v1
// targets; will mis-extract on heavily nested/inherited/multi-file
// contracts (e.g. `function transfer(...) external override returns
// (bool) { ... }` spanning modifiers or multi-line signatures with braces
// in comments) -- a known limitation of a regex-based approach, not
// silently assumed correct. Returns null if no match found.
function extractFunctionBody(source, name) {
  const sigRe = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{;]*\\{`, "m");
  const m = sigRe.exec(source);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) return null; // unbalanced -- extraction failed, don't guess
  return { body: source.slice(start, i - 1), startIndex: start, matchIndex: m.index };
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findAllowanceMappingName(source) {
  // mapping(address => mapping(address => uint256)) <visibility>? <name>;
  const m = /mapping\s*\(\s*address\s*=>\s*mapping\s*\(\s*address\s*=>\s*uint256\s*\)\s*\)\s*(?:public|private|internal)?\s*(\w+)\s*;/.exec(source);
  return m ? m[1] : null;
}

function checkFeeLogic(source, transferBodies) {
  // A bps-style fee calc: `<amount> * <rate> / <denominator like 10000>`
  // in either order, inside a transfer path, near a fee/burn/tax keyword.
  const bpsRe = /(\w+)\s*\*\s*(\w+)\s*\)?\s*\/\s*(10_?000|1e4)/i;
  for (const [fnName, extracted] of transferBodies) {
    if (!extracted) continue;
    const m = bpsRe.exec(extracted.body);
    if (m) {
      const line = lineNumberAt(source, extracted.startIndex + m.index);
      return {
        found: true,
        rateVarCandidate: [m[1], m[2]].find((v) => /fee|burn|tax|bps/i.test(v)) || m[2],
        evidence: { sourceLine: line, matchedText: m[0].trim(), inFunction: fnName },
      };
    }
  }
  return { found: false, evidence: { sourceLine: null, matchedText: null } };
}

function checkFeeRateMutability(source, rateVarName) {
  if (!rateVarName) return { result: "not_found", evidence: {} };
  const declRe = new RegExp(`uint256\\s+(public\\s+)?(constant|immutable)?\\s*${rateVarName}\\b`, "i");
  const m = declRe.exec(source);
  if (!m) return { result: "not_found", evidence: {} };
  const line = lineNumberAt(source, m.index);
  if (m[2]) {
    return { result: m[2].toLowerCase(), evidence: { sourceLine: line, matchedText: m[0].trim(), setterSelector: null } };
  }
  // Mutable storage var -- look for a setter that assigns to it.
  const setterRe = new RegExp(`function\\s+(\\w+)\\s*\\([^)]*\\)[^{]*\\{[^}]*\\b${rateVarName}\\s*=`, "m");
  const setterMatch = setterRe.exec(source);
  return {
    result: "mutable_with_setter",
    evidence: {
      sourceLine: line,
      matchedText: m[0].trim(),
      setterFunctionName: setterMatch ? setterMatch[1] : null,
      // Selector not computed -- would need a keccak256 implementation.
      // Reporting a wrong hand-rolled hash would be worse than omitting
      // it; the function NAME + source line is real, verifiable evidence
      // on its own.
      setterSelector: null,
    },
  };
}

function checkPrivilegedAddressCheck(transferBodies) {
  const re = /==\s*owner\b|owner\s*==|msg\.sender\s*==\s*(?!.*allowance)/i;
  for (const [fnName, extracted] of transferBodies) {
    if (!extracted) continue;
    const m = re.exec(extracted.body);
    if (m) {
      return { found: true, evidence: { matchedText: m[0].trim(), inFunction: fnName } };
    }
  }
  return { found: false, evidence: {} };
}

function checkNonAllowanceMappingRead(source, transferFromBody) {
  const allowanceName = findAllowanceMappingName(source);
  if (!transferFromBody) return { result: null, evidence: { note: "transferFrom not found or extraction failed" } };
  const mappingAccessRe = /\b(\w+)\s*\[[^\]]+\](?:\s*\[[^\]]+\])?/g;
  const suspicious = [];
  let m;
  while ((m = mappingAccessRe.exec(transferFromBody.body)) !== null) {
    const name = m[1];
    if (name === allowanceName) continue;
    if (["type", "require", "abi", "keccak256"].includes(name)) continue; // not mapping access
    suspicious.push(name);
  }
  const unique = [...new Set(suspicious)];
  return {
    result: unique.length > 0,
    evidence: {
      allowanceMappingName: allowanceName,
      otherMappingsRead: unique,
      note: unique.length > 0
        ? "transferFrom reads mapping(s) other than the declared allowance mapping -- THE DOCUMENTED DRAINER PATTERN, verify manually"
        : "transferFrom only reads the declared allowance mapping",
    },
  };
}

// Extracts every `if (...)` condition's full text with proper paren-depth
// matching -- a plain `[^)]+` regex truncates at the FIRST `)`, which
// breaks on any condition containing its own parens, e.g.
// `a != type(uint256).max` (confirmed live: this exact false positive
// happened on TACO's transferFrom before this fix, flagging the standard
// infinite-approval idiom as a non-standard bypass because the regex only
// ever saw the truncated text "a != type(uint256").
function extractIfConditions(body) {
  const conditions = [];
  const ifStartRe = /if\s*\(/g;
  let m;
  while ((m = ifStartRe.exec(body)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < body.length && depth > 0) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
      i++;
    }
    if (depth === 0) conditions.push(body.slice(start, i - 1).trim());
  }
  return conditions;
}

function checkAllowanceBypass(transferFromBody) {
  if (!transferFromBody) return { result: null, evidence: { note: "transferFrom not found or extraction failed" } };
  const standardIdiom = /type\s*\(\s*uint256\s*\)\s*\.\s*max/;
  const conditions = extractIfConditions(transferFromBody.body);
  const guardingAllowance = conditions.filter((c) => /allowance|\ba\b/.test(c));
  const nonStandard = guardingAllowance.filter((c) => !standardIdiom.test(c));
  return {
    result: nonStandard.length > 0,
    evidence: {
      allConditions: conditions,
      guardingAllowanceCheck: guardingAllowance,
      nonStandardConditions: nonStandard,
      note: nonStandard.length > 0
        ? "a conditional gates the allowance check/deduction WITHOUT the standard infinite-approval idiom (allowance == type(uint256).max) -- verify manually, this MAY gate the check based on address rather than allowance value"
        : guardingAllowance.length > 0
          ? "conditional matches the standard infinite-approval idiom only -- not a bypass"
          : "no conditional found guarding the allowance check",
    },
  };
}

function checkAdminFunctions(source) {
  const patterns = {
    mint_function: /function\s+_?mint\w*\s*\(/i,
    blacklist_function: /function\s+\w*(blacklist|blocklist)\w*\s*\(/i,
    pause_function: /function\s+\w*pause\w*\s*\(/i,
  };
  const out = {};
  for (const [id, re] of Object.entries(patterns)) {
    const m = re.exec(source);
    out[id] = { found: !!m, evidence: m ? { sourceLine: lineNumberAt(source, m.index), matchedText: m[0].trim() } : {} };
  }
  return out;
}

async function checkOwnerIsZero(chainCfg, tokenAddress) {
  // Live read, not source-derived -- the only reliable way to know the
  // CURRENT owner (a contract can have an owner() getter and still not
  // have called renounceOwnership() yet).
  try {
    const r = await fetch(chainCfg.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddress, data: "0x8da5cb5b" }, "latest"] }),
    });
    const j = await r.json();
    if (j.error) return { result: null, evidence: { note: `owner() call failed: ${j.error.message} -- contract may not expose a standard owner() getter` } };
    const owner = "0x" + j.result.slice(-40);
    const isZero = owner === "0x0000000000000000000000000000000000000000";
    return { result: isZero, evidence: { ownerAddress: owner, selector: "0x8da5cb5b" } };
  } catch (err) {
    return { result: null, evidence: { note: `owner() call failed: ${err.message}` } };
  }
}

function checkAsymmetricBuySell(source, feeCheck) {
  if (!feeCheck.found) return { result: null, evidence: { note: "no fee logic found to check for asymmetry" } };
  // Look at the conditional immediately guarding the fee calculation --
  // does it reference the recipient being a pair ("to"-side, i.e. a
  // sell) and/or the sender being a pair ("from"-side, i.e. a buy)?
  const contextStart = Math.max(0, feeCheck.evidence.matchedText ? source.indexOf(feeCheck.evidence.matchedText) - 300 : 0);
  const context = source.slice(contextStart, contextStart + 300);
  const ifMatch = /if\s*\(([^)]+)\)\s*\{[^}]*$/.exec(context);
  const condition = ifMatch ? ifMatch[1] : context;
  // Heuristic: which side of the transfer (to vs from) POSITIVELY (not
  // negated) gates the fee. A negated match like `!isPair[f]` is an
  // EXCLUSION ("only tax if the sender is NOT a pair", i.e. it rules out
  // taxing buys) rather than a signal that the buy path is taxed.
  //
  // A regex negative-lookbehind (`(?<!!\s*)`) does NOT work for this,
  // confirmed live: `\w*` is variable-length, so the engine can start the
  // match partway through an identifier (e.g. at the "s" of "isPair[f]"
  // instead of the "i"), which sidesteps the lookbehind entirely since it
  // only inspects whatever's immediately before wherever the match
  // happens to start -- `/(?<!!\s*)\w*\[\s*f\s*\]/.test("!isPair[f]")`
  // returns true, which is wrong. Fixed by requiring a `\b` word boundary
  // (forcing full-identifier matches, not partial) and manually walking
  // backward from each match's own index to check for "!", rather than
  // asking the regex engine to do it.
  function findsPositiveSideCheck(sideRe) {
    const re = new RegExp(sideRe, "g");
    let m;
    let sawPositive = false, sawNegatedOnly = false;
    while ((m = re.exec(condition)) !== null) {
      let i = m.index - 1;
      while (i >= 0 && /\s/.test(condition[i])) i--;
      const negated = i >= 0 && condition[i] === "!";
      if (negated) sawNegatedOnly = true;
      else sawPositive = true;
    }
    return { positive: sawPositive, negatedOnly: sawNegatedOnly && !sawPositive };
  }
  const toSideCheck = findsPositiveSideCheck(String.raw`\b\w+\[\s*to\s*\]`);
  const fromSideCheck = findsPositiveSideCheck(String.raw`\b\w+\[\s*f(?:rom)?\s*\]`);
  const toSideNegatedOnly = toSideCheck.negatedOnly;
  const fromSideNegatedOnly = fromSideCheck.negatedOnly;
  const toSidePair = toSideCheck.positive;
  const fromSidePair = fromSideCheck.positive;
  const asymmetric = toSidePair !== fromSidePair; // exactly one side positively gates it, not both
  return {
    result: asymmetric,
    evidence: {
      matchedCondition: condition.trim(),
      appliesOnSellPath: toSidePair,
      appliesOnBuyPath: fromSidePair,
      toSideOnlyAsNegatedExclusion: toSideNegatedOnly,
      fromSideOnlyAsNegatedExclusion: fromSideNegatedOnly,
      note: asymmetric
        ? (toSidePair ? "fee applies on sell (transfer INTO a pair) only" : "fee applies on buy (transfer FROM a pair) only")
        : (toSidePair && fromSidePair ? "fee applies on both buy and sell" : "could not determine which side triggers the fee -- verify manually"),
    },
  };
}

/**
 * @param {{address: string}} tokenCfg
 * @param {object} chainCfg
 * @returns {Promise<Array>} static + the one live ownership check, all
 *   matching scanner/verdict.schema.json
 */
export async function runStaticChecks(tokenCfg, chainCfg) {
  const ownerCheck = await checkOwnerIsZero(chainCfg, tokenCfg.address);
  const ownerEntry = { id: "owner_is_zero", kind: "dynamic", result: ownerCheck.result, evidence: ownerCheck.evidence };

  let contractInfo;
  try {
    contractInfo = await fetchSource(chainCfg, tokenCfg.address);
  } catch (err) {
    return [ownerEntry, {
      id: "fee_logic_present", kind: "static", result: null,
      evidence: { note: `could not fetch contract info: ${err.message}` },
    }];
  }

  if (!contractInfo.is_verified) {
    return [ownerEntry, {
      id: "fee_logic_present", kind: "static", result: null,
      evidence: { note: "source not verified on this explorer -- static analysis needs verified source in this v1 (no bytecode-only fallback implemented, see README)" },
    }];
  }

  const source = contractInfo.source_code || "";
  const transferBodies = FUNCTION_NAMES.map((name) => [name, extractFunctionBody(source, name)]);
  const transferFromBody = transferBodies.find(([n]) => n === "transferFrom")?.[1] || null;

  const feeCheck = checkFeeLogic(source, transferBodies);
  const mutability = checkFeeRateMutability(source, feeCheck.rateVarCandidate);
  const privileged = checkPrivilegedAddressCheck(transferBodies);
  const nonAllowanceRead = checkNonAllowanceMappingRead(source, transferFromBody);
  const allowanceBypass = checkAllowanceBypass(transferFromBody);
  const admin = checkAdminFunctions(source);
  const asymmetry = checkAsymmetricBuySell(source, feeCheck);

  return [
    ownerEntry,
    { id: "fee_logic_present", kind: "static", result: feeCheck.found, evidence: feeCheck.evidence },
    { id: "fee_rate_mutability", kind: "static", result: mutability.result, evidence: mutability.evidence },
    { id: "privileged_address_check", kind: "static", result: privileged.found, evidence: privileged.evidence },
    { id: "non_allowance_mapping_read", kind: "static", result: nonAllowanceRead.result, evidence: nonAllowanceRead.evidence },
    { id: "allowance_bypass", kind: "static", result: allowanceBypass.result, evidence: allowanceBypass.evidence },
    { id: "mint_function", kind: "static", result: admin.mint_function.found, evidence: admin.mint_function.evidence },
    { id: "blacklist_function", kind: "static", result: admin.blacklist_function.found, evidence: admin.blacklist_function.evidence },
    { id: "pause_function", kind: "static", result: admin.pause_function.found, evidence: admin.pause_function.evidence },
    { id: "asymmetric_buy_sell", kind: "static", result: asymmetry.result, evidence: asymmetry.evidence },
  ];
}
