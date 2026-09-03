# Security policy

## Supported versions

Only the latest version on the default branch is supported with security fixes. Please
upgrade before reporting an issue against an older checkout.

## Reporting a vulnerability

Please do not disclose vulnerabilities in a public GitHub issue. Use GitHub's private
vulnerability reporting for this repository, if enabled, or contact the Mailbutler
maintainers privately through GitHub.

Include:

- A description of the issue and its potential impact.
- Steps to reproduce it without sharing real customer data or credentials.
- Affected versions, files, or configuration.
- Any suggested mitigation.

We will acknowledge reports when possible, investigate privately, and coordinate public
disclosure after a fix or mitigation is available.

## Protecting migration data

This project can access sensitive support data. Keep API tokens in environment variables,
use least-privilege credentials, run dry-runs first, and treat logs, checkpoints, and
exported maps as sensitive. If a credential is exposed, revoke it immediately.
