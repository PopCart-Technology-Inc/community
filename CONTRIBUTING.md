# Contributing

Thanks for helping build PopCart Community. The project is at its very start, so the most useful contributions right now are issues and discussion about **Profiles**, the first part.

## First: this repo is public

Security and leaks come before everything else. Read [AGENTS.md](AGENTS.md), then switch on the leak checks once in your clone:

```
git config core.hooksPath .githooks
```

They check every commit and push for secrets, personal data and internal details. Never skip them with `--no-verify`. CI runs the same checks plus gitleaks over the whole history.

## Ground rules

- **Be kind.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **Data rule first.** Any change must fit [hold keys, not data](docs/decisions/0001-hold-keys-not-data.md). If a feature needs new personal data, open an issue first and say why.
- **No fake data in the product.** Anything that can change is shown live, with the time it was read ("as of"). Examples in designs and docs are labelled as examples.
- **Small pull requests**, one change each, with tests when there is code.

## Sign-off (DCO)

Every commit needs a `Signed-off-by` line certifying the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or have the right to submit it under this project's licences.

```
git commit -s -m "Describe the change"
```

By contributing, you license your code under [AGPL-3.0](LICENSE) and your documentation under [CC BY 4.0](LICENSE-DOCS). The PopCart trademarks are not licensed; see [TRADEMARKS.md](TRADEMARKS.md).

## Decisions

Bigger choices are written down in [docs/decisions](docs/decisions/) as numbered records: Proposed → Accepted or Rejected. To propose one, open a pull request with a new record.
