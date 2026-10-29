# Security Policy

Mina can start and stop processes on your machine, so we take security seriously. The protections are described in the [README](README.md#-security) and in detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

**Please don't put exploit details in a public issue.**

1. Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on the repository.
2. If that isn't available, open an issue titled *"Security contact request"* with **no details**, and we'll reach out privately.

Please include:
- The Mina version (`mina --version`), your OS and your Node.js version
- What an attacker can do, and under what conditions (e.g. "a website the user visits can…")
- Steps to reproduce or a proof of concept

You can expect an acknowledgment within a few days. We'll keep you updated while we work on a fix and credit you in the release notes, unless you'd rather stay anonymous.

## In scope

- Any way for a web page, another local user or a network peer to call Mina's API
- Bypassing the token, Origin or Host checks
- Starting arbitrary commands, killing arbitrary processes or opening arbitrary paths
- Reading files outside `public/` through the static file handler

## Out of scope

- Attacks that need an attacker already running code as your user on your machine
- What your own dev servers do once Mina has started them
