# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## ⚠️ IMPORTANT: Pre-Audit Warning

**RadiantMM is currently in development and has NOT undergone a formal security audit.**

Do NOT use this contract with significant funds until:
1. A formal security audit has been completed
2. The contract has been battle-tested on testnet
3. Bug bounty program has been established

## Reporting a Vulnerability

### How to Report

1. **Do NOT** create a public GitHub issue for security vulnerabilities
2. Email security concerns to the maintainers
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### Response Timeline

- **Initial Response:** Within 24 hours for critical issues
- **Status Update:** Within 3 days
- **Resolution Target:** Within 14 days for critical issues

## Security Considerations

### Smart Contract Risks

RadiantMM implements an automated market maker (AMM) with the following known risks:

1. **Impermanent Loss:** LPs may lose value due to price divergence
2. **Slippage:** Large trades may experience significant slippage
3. **MEV:** Front-running and sandwich attacks are possible (mitigation planned)
4. **Integer Overflow:** While protected, edge cases may exist

### Known Limitations

1. **No MEV Protection:** The current implementation does not include MEV protection
2. **Limited Testing:** Edge cases in integer math may not be fully covered
3. **No Formal Verification:** Contract logic has not been formally verified

### Audit Requirements

Before production use, the following audits are required:

- [ ] Smart contract formal verification
- [ ] Economic model review
- [ ] Integer math edge case analysis
- [ ] MEV vulnerability assessment

## Dependencies

- `@radiantblockchain/radiantjs` - Cryptographic operations
- `@radiantblockchain/constants` - Protocol constants

## Security Checklist for Users

Before using RadiantMM:

- [ ] Verify you're using the official contract
- [ ] Start with small amounts
- [ ] Understand impermanent loss risks
- [ ] Monitor your positions regularly
- [ ] Never invest more than you can afford to lose

---

*Last updated: January 2026*
*Status: PRE-AUDIT - Use at your own risk*
