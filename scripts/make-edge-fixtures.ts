/**
 * Build the synthetic edge-case EvidenceBundles.
 *
 *   npx tsx scripts/make-edge-fixtures.ts
 *
 * The four real mainnet bundles cover the realistic path. These cover the §5
 * failure-mode table, which is rare in the wild and easy to construct by hand:
 *
 *   edge-no-source.json        verifiedSource: null      -> must not invent a name
 *   edge-unresolvable.json     hash resolves nowhere     -> unknown + declaredUnknown
 *   edge-empty.json            permissions: []           -> clean empty, no throw
 *   edge-inherited-base.json   role declared in an absent base -> exercises brute_force
 *   edge-active-keeper.json    non-empty callHistory     -> obvious load_bearing + vestigial
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hash, ZERO_HASH } from '../src/agent/keccak.js';
import type { EvidenceBundle } from '../src/agent/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../evals/fixtures');

const KEEPER = '0x3e40d73eb977dc6a537af587d48316fee66e9c8c';
const BLOCK = 21_500_000;

const chainContext = { chainId: 1, chainName: 'ethereum-mainnet', currentBlock: BLOCK };
const deadKeeper = { address: KEEPER, chainId: 1, provider: 'manual' as const };

const fn = (name: string, inputs: Array<{ name: string; type: string }> = []) => ({
  type: 'function',
  name,
  inputs,
  outputs: [],
  stateMutability: 'nonpayable',
});

const write = (name: string, bundle: EvidenceBundle): void => {
  writeFileSync(join(outDir, name), JSON.stringify(bundle, null, 2) + '\n');
  console.log(`✓ ${name.padEnd(28)} ${bundle.permissions.length} perms`);
};

/* ── 1. verifiedSource is null ────────────────────────────────────────────── */
/* Fall back to ABI + call history. Must NOT invent a role name.              */

const NO_SOURCE = '0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

write('edge-no-source.json', {
  deadKeeper,
  permissions: [
    { contract: NO_SOURCE, roleHash: hash('OPERATOR_ROLE'), grantedAtBlock: BLOCK - 900_000, stillActive: true },
    {
      // Unverifiable AND unresolvable: no source, no standards match.
      contract: NO_SOURCE,
      roleHash: '0x7c1e9b4a08f3d25e6a0b93cc47182fd05e6a3b91c8d472fa15e0937b62c48ad3',
      grantedAtBlock: BLOCK - 900_000,
      stillActive: true,
    },
  ],
  contracts: {
    [NO_SOURCE]: {
      address: NO_SOURCE,
      name: null,
      isProxy: false,
      implementationAddress: null,
      verifiedSource: null, // <- the failure mode
      abi: [
        fn('settleEpoch', [{ name: 'epochId', type: 'uint256' }]),
        fn('setOracle', [{ name: 'oracle', type: 'address' }]),
        fn('hasRole', [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }]),
      ],
    },
  },
  callHistory: [
    { contract: NO_SOURCE, selector: '0x8f3a1c2b', functionName: 'settleEpoch', count: 1284, firstBlock: BLOCK - 890_000, lastBlock: BLOCK - 1_200 },
  ],
  chainContext,
});

/* ── 2. Role hash resolves nowhere ────────────────────────────────────────── */
/* Source IS available and parses fine — the hash simply matches no constant. */

const UNRESOLVABLE = '0xb2c3d4e5f60718293a4b5c6d7e8f901234567890';

const vaultSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Yield vault with a single operational role.
contract YieldVault is AccessControl {
    bytes32 public constant HARVESTER_ROLE = keccak256("HARVESTER_ROLE");

    uint256 public lastHarvest;

    function harvest() external onlyRole(HARVESTER_ROLE) {
        lastHarvest = block.timestamp;
    }
}
`;

write('edge-unresolvable.json', {
  deadKeeper,
  permissions: [
    { contract: UNRESOLVABLE, roleHash: hash('HARVESTER_ROLE'), grantedAtBlock: BLOCK - 500_000, stillActive: true },
    {
      // Granted on-chain, but nothing in this bundle explains what it is.
      contract: UNRESOLVABLE,
      roleHash: '0x3d9f0c71a2e845bb61c0f38d94a7e2150b6c48fa3e97d215806b4cf39e1a7d62',
      grantedAtBlock: BLOCK - 500_000,
      stillActive: true,
    },
  ],
  contracts: {
    [UNRESOLVABLE]: {
      address: UNRESOLVABLE,
      name: 'YieldVault',
      isProxy: false,
      implementationAddress: null,
      verifiedSource: vaultSource,
      abi: [fn('harvest'), fn('lastHarvest')],
    },
  },
  callHistory: [
    { contract: UNRESOLVABLE, selector: '0x4641257d', functionName: 'harvest', count: 806, firstBlock: BLOCK - 495_000, lastBlock: BLOCK - 400 },
  ],
  chainContext,
});

/* ── 3. Empty permissions ─────────────────────────────────────────────────── */
/* Must return an empty analysis cleanly and never throw. Also must not make   */
/* a model call at all — there is nothing to judge.                            */

write('edge-empty.json', {
  deadKeeper,
  permissions: [],
  contracts: {},
  callHistory: [],
  chainContext,
});

/* ── 4. Role inherited from a base contract absent from the bundle ────────── */
/* The source USES onlyRole(SETTLEMENT_ROLE) but never declares it — the      */
/* declaration lives in an import that Scout did not capture. Extraction finds */
/* nothing, so this is the one case where the model must hypothesise a name    */
/* and code confirms it by brute force. Exercises resolutionMethod            */
/* 'brute_force', which no other fixture reaches.                              */

const INHERITED = '0xc3d4e5f60718293a4b5c6d7e8f90123456789012';

const settlementSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "./base/SettlementRoles.sol"; // <- NOT included in this bundle
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Settles trading epochs. Role constants are declared in SettlementRoles.
contract SettlementEngine is SettlementRoles, AccessControl {
    event EpochSettled(uint256 indexed epoch, uint256 notional);

    uint256 public currentEpoch;

    /// @dev SETTLEMENT_ROLE is declared in SettlementRoles.sol, not here.
    function settle(uint256 notional) external onlyRole(SETTLEMENT_ROLE) {
        currentEpoch += 1;
        emit EpochSettled(currentEpoch, notional);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }
}
`;

write('edge-inherited-base.json', {
  deadKeeper,
  permissions: [
    { contract: INHERITED, roleHash: hash('SETTLEMENT_ROLE'), grantedAtBlock: BLOCK - 300_000, stillActive: true },
    { contract: INHERITED, roleHash: hash('PAUSER_ROLE'), grantedAtBlock: BLOCK - 300_000, stillActive: true },
  ],
  contracts: {
    [INHERITED]: {
      address: INHERITED,
      name: 'SettlementEngine',
      isProxy: false,
      implementationAddress: null,
      verifiedSource: settlementSource,
      abi: [fn('settle', [{ name: 'notional', type: 'uint256' }]), fn('pause'), fn('currentEpoch')],
    },
  },
  callHistory: [
    { contract: INHERITED, selector: '0x9d2f1e77', functionName: 'settle', count: 2451, firstBlock: BLOCK - 299_000, lastBlock: BLOCK - 60 },
  ],
  chainContext,
});

/* ── 5. Active keeper with real call history ──────────────────────────────── */
/* The clear-cut pair: a heavily-used automation role (load_bearing beyond     */
/* argument) and an untouched convenience role (vestigial beyond argument).    */
/* Every other fixture has an empty callHistory, so without this one the eval  */
/* set never tests the easy direction.                                         */

const ACTIVE = '0xd4e5f60718293a4b5c6d7e8f9012345678901234';

const automationSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Chainlink-compatible automation target for a lending market.
contract RateUpdater is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant FEE_SETTER_ROLE = keccak256("FEE_SETTER_ROLE");

    address public feeRecipient;
    uint256 public lastUpdate;

    function checkUpkeep(bytes calldata)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        upkeepNeeded = block.timestamp - lastUpdate > 1 hours;
        performData = "";
    }

    /// @dev The automation entrypoint. Guarded by KEEPER_ROLE.
    function performUpkeep(bytes calldata) external onlyRole(KEEPER_ROLE) {
        lastUpdate = block.timestamp;
        _accrueInterest();
    }

    /// @dev Operational convenience. Several admins hold this role.
    function setFeeRecipient(address recipient) external onlyRole(FEE_SETTER_ROLE) {
        feeRecipient = recipient;
    }

    function _accrueInterest() internal {}
}
`;

write('edge-active-keeper.json', {
  deadKeeper,
  upkeep: {
    id: '84920174455092375028374650192837465019283746501928374650192837465',
    targetContract: ACTIVE,
    checkFunctionSig: 'checkUpkeep(bytes) returns (bool,bytes)',
    performFunctionSig: 'performUpkeep(bytes)',
    adminAddress: KEEPER,
    balance: '785000000000000000',
  },
  permissions: [
    { contract: ACTIVE, roleHash: hash('KEEPER_ROLE'), grantedAtBlock: BLOCK - 1_200_000, stillActive: true },
    { contract: ACTIVE, roleHash: hash('FEE_SETTER_ROLE'), grantedAtBlock: BLOCK - 1_200_000, stillActive: true },
    { contract: ACTIVE, roleHash: ZERO_HASH, grantedAtBlock: BLOCK - 1_200_000, stillActive: true },
  ],
  contracts: {
    [ACTIVE]: {
      address: ACTIVE,
      name: 'RateUpdater',
      isProxy: false,
      implementationAddress: null,
      verifiedSource: automationSource,
      abi: [
        fn('checkUpkeep', [{ name: '', type: 'bytes' }]),
        fn('performUpkeep', [{ name: '', type: 'bytes' }]),
        fn('setFeeRecipient', [{ name: 'recipient', type: 'address' }]),
        fn('feeRecipient'),
      ],
    },
  },
  callHistory: [
    // Dense, regular, recent -> unambiguous load_bearing.
    { contract: ACTIVE, selector: '0x4585e33b', functionName: 'performUpkeep', count: 8_642, firstBlock: BLOCK - 1_199_000, lastBlock: BLOCK - 240 },
    // setFeeRecipient never appears -> unambiguous vestigial.
  ],
  chainContext,
});

/* ── 6. Proxy whose implementation source is missing from the bundle ──────── */
/* Realistic Scout failure: the proxy verified, the implementation did not.    */
/* The proxy's own source has no business logic, so the roles are ungovernable */
/* from this bundle alone. Must be declared, not guessed.                      */

const PROXY_NO_IMPL = '0xe5f60718293a4b5c6d7e8f901234567890123456';
const MISSING_IMPL = '0xf60718293a4b5c6d7e8f90123456789012345678';

const bareProxySource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/// @notice Minimal EIP-1967 proxy. All logic lives behind the implementation slot.
contract TransparentProxy {
    bytes32 internal constant _IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    fallback() external payable {
        assembly {
            let impl := sload(_IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
`;

write('edge-proxy-no-impl.json', {
  deadKeeper,
  permissions: [
    { contract: PROXY_NO_IMPL, roleHash: hash('MINTER_ROLE'), grantedAtBlock: BLOCK - 200_000, stillActive: true },
    { contract: PROXY_NO_IMPL, roleHash: ZERO_HASH, grantedAtBlock: BLOCK - 200_000, stillActive: true },
  ],
  contracts: {
    [PROXY_NO_IMPL]: {
      address: PROXY_NO_IMPL,
      name: 'TransparentProxy',
      isProxy: true,
      implementationAddress: MISSING_IMPL, // <- points at a contract NOT in this bundle
      verifiedSource: bareProxySource,
      abi: null,
    },
  },
  callHistory: [],
  chainContext,
});

/* ── 7. Genuinely vestigial roles ─────────────────────────────────────────── */
/* The real mainnet bundles are governance-held emergency controls, so they    */
/* are almost all load_bearing. Without this fixture the eval set has no       */
/* meaningful negative class and a constant "load_bearing" guess scores well.  */
/* These are non-emergency conveniences, unused, with the source itself        */
/* recording that the mechanism is retired.                                    */

const VESTIGIAL = '0x0718293a4b5c6d7e8f9012345678901234567890';

const legacySource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Collection contract. The allowlist mechanism was retired at launch.
contract Collection is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant METADATA_ROLE = keccak256("METADATA_ROLE");
    bytes32 public constant ALLOWLIST_ROLE = keccak256("ALLOWLIST_ROLE");

    string public baseURI;
    bool public allowlistActive = false;
    uint256 public lastSync;

    /// @dev The live automation path. Runs every epoch.
    function performUpkeep(bytes calldata) external onlyRole(KEEPER_ROLE) {
        lastSync = block.timestamp;
    }

    /// @notice Updates the metadata base URI.
    /// @dev Cosmetic only. The team multisig and three other operators also hold
    ///      METADATA_ROLE; this keeper was granted it during setup and never used it.
    function setBaseURI(string calldata uri) external onlyRole(METADATA_ROLE) {
        baseURI = uri;
    }

    /// @notice Adds an address to the mint allowlist.
    /// @dev DEPRECATED. allowlistActive has been false since deployment and the
    ///      public mint has closed. This function has no reachable effect.
    function addToAllowlist(address account) external onlyRole(ALLOWLIST_ROLE) {
        require(allowlistActive, "ALLOWLIST_DISABLED");
        _allowlist[account] = true;
    }

    mapping(address => bool) private _allowlist;
}
`;

write('edge-vestigial.json', {
  deadKeeper,
  permissions: [
    { contract: VESTIGIAL, roleHash: hash('KEEPER_ROLE'), grantedAtBlock: BLOCK - 700_000, stillActive: true },
    { contract: VESTIGIAL, roleHash: hash('METADATA_ROLE'), grantedAtBlock: BLOCK - 700_000, stillActive: true },
    { contract: VESTIGIAL, roleHash: hash('ALLOWLIST_ROLE'), grantedAtBlock: BLOCK - 700_000, stillActive: true },
  ],
  contracts: {
    [VESTIGIAL]: {
      address: VESTIGIAL,
      name: 'Collection',
      isProxy: false,
      implementationAddress: null,
      verifiedSource: legacySource,
      abi: [
        fn('performUpkeep', [{ name: '', type: 'bytes' }]),
        fn('setBaseURI', [{ name: 'uri', type: 'string' }]),
        fn('addToAllowlist', [{ name: 'account', type: 'address' }]),
        fn('allowlistActive'),
      ],
    },
  },
  callHistory: [
    { contract: VESTIGIAL, selector: '0x4585e33b', functionName: 'performUpkeep', count: 5_204, firstBlock: BLOCK - 699_000, lastBlock: BLOCK - 120 },
    // setBaseURI and addToAllowlist never appear.
  ],
  chainContext,
});

console.log('\nEdge-case fixtures written to evals/fixtures/');
