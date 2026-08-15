// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title MockERC721
 * @notice Test-only stand-in for the Green Flock collection.
 *         Not part of the production deployment.
 */
contract MockERC721 is ERC721 {
    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function mintBatch(address to, uint256 firstId, uint256 count) external {
        for (uint256 i = 0; i < count; i++) {
            _mint(to, firstId + i);
        }
    }
}
