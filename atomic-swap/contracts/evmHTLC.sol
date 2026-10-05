// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================
// Bradicoin HTLC — Cross-Chain Atomic Swap
// ============================================
// Contrato HTLC compatível com swaps atômicos.
// Suporta:
//   - Lock com hashlock + timelock
//   - Claim com preimage
//   - Refund após timelock
//   - Native coin (ETH/BNB/MATIC/AVAX) e ERC20
// ============================================

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract BradicoinHTLC {
    // ============================================
    // ESTRUTURAS
    // ============================================
    struct Swap {
        address sender;         // quem travou
        address receiver;       // quem pode resgatar
        address token;          // address(0) = native (ETH/BNB/...)
        uint256 amount;         // valor travado
        bytes32 hashlock;       // H = sha256(preimage)
        uint256 timelock;       // unix timestamp
        bool claimed;           // já foi claimed?
        bool refunded;          // já foi refundado?
        bytes32 preimage;       // preimage revelado no claim
    }

    // ============================================
    // STATE
    // ============================================
    mapping(bytes32 => Swap) public swaps;      // swapId → Swap
    mapping(bytes32 => bool) public usedHashlocks;  // hashlock → usado?

    uint256 public constant MIN_TIMELOCK = 30 minutes;
    uint256 public constant MAX_TIMELOCK = 7 days;

    // ============================================
    // EVENTS
    // ============================================
    event Locked(
        bytes32 indexed swapId,
        address indexed sender,
        address indexed receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );

    event Claimed(
        bytes32 indexed swapId,
        address indexed claimer,
        bytes32 preimage
    );

    event Refunded(
        bytes32 indexed swapId,
        address indexed refunder
    );

    // ============================================
    // LOCK — Native coin
    // ============================================
    function lockNative(
        bytes32 swapId,
        address receiver,
        bytes32 hashlock,
        uint256 timelock
    ) external payable {
        require(msg.value > 0, "amount must be > 0");
        require(receiver != address(0), "receiver invalid");
        require(!usedHashlocks[hashlock], "hashlock already used");
        require(swaps[swapId].sender == address(0), "swapId already exists");
        _validateTimelock(timelock);

        swaps[swapId] = Swap({
            sender: msg.sender,
            receiver: receiver,
            token: address(0),
            amount: msg.value,
            hashlock: hashlock,
            timelock: timelock,
            claimed: false,
            refunded: false,
            preimage: bytes32(0)
        });

        usedHashlocks[hashlock] = true;

        emit Locked(swapId, msg.sender, receiver, address(0), msg.value, hashlock, timelock);
    }

    // ============================================
    // LOCK — ERC20
    // ============================================
    function lockERC20(
        bytes32 swapId,
        address token,
        uint256 amount,
        address receiver,
        bytes32 hashlock,
        uint256 timelock
    ) external {
        require(token != address(0), "token invalid");
        require(amount > 0, "amount must be > 0");
        require(receiver != address(0), "receiver invalid");
        require(!usedHashlocks[hashlock], "hashlock already used");
        require(swaps[swapId].sender == address(0), "swapId already exists");
        _validateTimelock(timelock);

        // Transfer from sender → contrato
        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "transferFrom failed"
        );

        swaps[swapId] = Swap({
            sender: msg.sender,
            receiver: receiver,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            claimed: false,
            refunded: false,
            preimage: bytes32(0)
        });

        usedHashlocks[hashlock] = true;

        emit Locked(swapId, msg.sender, receiver, token, amount, hashlock, timelock);
    }

    // ============================================
    // CLAIM — Revela preimage
    // ============================================
    function claim(bytes32 swapId, bytes32 preimage) external {
        Swap storage s = swaps[swapId];
        require(s.sender != address(0), "swap not found");
        require(!s.claimed, "already claimed");
        require(!s.refunded, "already refunded");
        require(block.timestamp < s.timelock, "swap expired");

        // ⚠️ Verifica H = sha256(preimage)
        // Nota: EVM usa keccak256 por padrão, mas pra compatibilidade
        // cross-chain (Bitcoin usa SHA256), usamos sha256 aqui.
        bytes32 computed = sha256(abi.encodePacked(preimage));
        require(computed == s.hashlock, "invalid preimage");

        s.claimed = true;
        s.preimage = preimage;

        // Envia fundos pro receiver
        if (s.token == address(0)) {
            (bool ok, ) = payable(s.receiver).call{value: s.amount}("");
            require(ok, "native transfer failed");
        } else {
            require(
                IERC20(s.token).transfer(s.receiver, s.amount),
                "token transfer failed"
            );
        }

        emit Claimed(swapId, msg.sender, preimage);
    }

    // ============================================
    // REFUND — Após timelock
    // ============================================
    function refund(bytes32 swapId) external {
        Swap storage s = swaps[swapId];
        require(s.sender != address(0), "swap not found");
        require(!s.claimed, "already claimed");
        require(!s.refunded, "already refunded");
        require(block.timestamp >= s.timelock, "timelock not expired");
        require(msg.sender == s.sender, "only sender can refund");

        s.refunded = true;

        if (s.token == address(0)) {
            (bool ok, ) = payable(s.sender).call{value: s.amount}("");
            require(ok, "refund failed");
        } else {
            require(
                IERC20(s.token).transfer(s.sender, s.amount),
                "refund token failed"
            );
        }

        emit Refunded(swapId, msg.sender);
    }

    // ============================================
    // VIEW
    // ============================================
    function getSwap(bytes32 swapId) external view returns (Swap memory) {
        return swaps[swapId];
    }

    function isClaimable(bytes32 swapId, bytes32 preimage) external view returns (bool) {
        Swap storage s = swaps[swapId];
        if (s.claimed || s.refunded) return false;
        if (block.timestamp >= s.timelock) return false;
        bytes32 computed = sha256(abi.encodePacked(preimage));
        return computed == s.hashlock;
    }

    function isRefundable(bytes32 swapId) external view returns (bool) {
        Swap storage s = swaps[swapId];
        if (s.claimed || s.refunded) return false;
        return block.timestamp >= s.timelock;
    }

    // ============================================
    // INTERNAL
    // ============================================
    function _validateTimelock(uint256 timelock) internal view {
        require(timelock > block.timestamp + MIN_TIMELOCK, "timelock too short");
        require(timelock < block.timestamp + MAX_TIMELOCK, "timelock too long");
    }

    // ============================================
    // SAFETY
    // ============================================
    receive() external payable {
        revert("use lockNative");
    }

    fallback() external payable {
        revert("no fallback");
    }
}
