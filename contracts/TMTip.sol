// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TM 打赏合约
/// @notice 收到的 BNB 在同一笔交易里原样转给作者地址(部署时写死,之后改不了)。
///         没有 owner、没有管理函数、合约里不存钱,谁都没法把钱转去别处。
contract TMTip {
    address payable public immutable author;

    event Tipped(address indexed from, uint256 amount, string memo);

    constructor(address payable author_) {
        require(author_ != address(0), "author=0");
        author = author_;
    }

    /// @param memo 打赏留言(可以为空,最多 140 字节)
    function tip(string calldata memo) external payable {
        _forward(memo);
    }

    /// 直接给合约转 BNB 也算打赏
    receive() external payable {
        _forward("");
    }

    function _forward(string memory memo) private {
        require(msg.value > 0, "amount=0");
        require(bytes(memo).length <= 140, "memo too long");
        (bool ok, ) = author.call{value: msg.value}("");
        require(ok, "forward failed");
        emit Tipped(msg.sender, msg.value, memo);
    }
}
