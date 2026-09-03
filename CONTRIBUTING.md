# Contributing to Groove → Intercom Migrator

Thanks for helping improve this project. Contributions are welcome through GitHub pull
requests.

## Before you start

- Check existing issues and pull requests before starting substantial work.
- Open an issue first for large changes or changes to migration behavior.
- Do not include real Groove, Intercom, Jira, or customer data in issues, tests, fixtures,
  logs, or pull requests.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
  public issue.

## Development setup

This project requires Node.js 20 or newer.

```bash
npm ci
cp .env.example .env
npm run typecheck
npm test
```

Use placeholder credentials or mocked clients in tests. Do not run migration commands
against production services while developing.

## Pull requests

Please keep pull requests focused and include:

- A clear description of the problem and solution.
- Tests for changed behavior, when practical.
- Documentation updates for user-visible changes.
- Any migration, data-loss, or API compatibility considerations.

Before submitting, run `npm run typecheck` and `npm test`. Pull requests should not
commit generated `dist/` output, local environment files, checkpoints, or migration maps.

## Commit and review expectations

Use concise commit messages that describe the change. Maintainers may ask for revisions
to improve correctness, test coverage, documentation, or compatibility with supported
Groove and Intercom API responses.
