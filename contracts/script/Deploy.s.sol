// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LegacyProtocol} from "../src/LegacyProtocol.sol";

/// Deploys three LegacyProtocol instances so the blast-radius scan returns a
/// multi-contract result, as a real migration would.
///
///   forge script script/Deploy.s.sol --rpc-url sepolia --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin    = vm.addr(pk);
        address oldKeeper = vm.envAddress("OLD_KEEPER");   // the "dead" keeper
        address guardian  = vm.envAddress("GUARDIAN");

        vm.startBroadcast(pk);

        // epoch 1h / window 10m — settlement is genuinely time-critical
        LegacyProtocol vault = new LegacyProtocol(admin, oldKeeper, guardian, 1 hours, 10 minutes);
        // epoch 6h / window 1h — generous window; late is tolerable here
        LegacyProtocol treasury = new LegacyProtocol(admin, oldKeeper, guardian, 6 hours, 1 hours);
        // epoch 15m / window 2m — tight window; a missed beat matters
        LegacyProtocol oracle = new LegacyProtocol(admin, oldKeeper, guardian, 15 minutes, 2 minutes);

        vm.stopBroadcast();

        console.log("vault    ", address(vault));
        console.log("treasury ", address(treasury));
        console.log("oracle   ", address(oracle));
        console.log("oldKeeper", oldKeeper);
        console.log("admin    ", admin);
    }
}
