# Reviews and releases

How a change gets from a contributor's pull request into a released version. Written for maintainers; contributors start with [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. The path of a pull request

```
fork or branch → pull request → checks → maintainer review → squash merge → Unreleased → release tag
```

1. **Checks run** on every pull request. Both must be green:
   - `leakcheck`: our scanner and gitleaks over the whole history;
   - `dco`: every commit is signed off by its author, and the change is versioned: it adds a line under `## [Unreleased]` in CHANGELOG.md, or it is a release with the right next version (`tools/ci/changelog.py check`, also run by the pre-push hook).
   For a contributor's first pull requests, a maintainer approves the workflow run first (GitHub asks for this for every outside contributor).
2. **A maintainer reviews it** (CODEOWNERS: `@PopCart-Technology-Inc/community-maintainers`). Nobody can merge a pull request without that approval. A new push after the approval needs a fresh approval, and every review conversation must be resolved.
3. **Squash merge.** Only squash merges are allowed, so `main` has one commit per pull request with the pull request title, and the sign-offs are kept in the message.
4. **The change waits under `## [Unreleased]`** in CHANGELOG.md until the next release.

## 2. Review checklist

Before approving, a maintainer checks, in this order:

1. **Leaks.** Read the whole diff and every commit message. Then run the check locally with the private list, because pull requests from forks run CI without it. Run it **from `main`**, so the pull request's commits are only read as data and none of its code runs on your machine:
   ```
   git switch main && git pull
   git fetch origin pull/<number>/head:pr-<number>
   python tools/leakcheck/leakcheck.py --range main..pr-<number>
   ```
2. **Changes to the checks themselves** (`.github/`, `.githooks/`, `.claude/`, `tools/`): read every line. A pull request must never weaken a check, add `pull_request_target`, add secrets to a workflow, or use an action that is not pinned to a full commit SHA.
3. **The data rule** ([decision 0001](decisions/0001-hold-keys-not-data.md)): no new personal data without an agreed issue.
4. **No fake data**, tests where there is code, one line in CHANGELOG.md.

## 3. Versions

Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

| Change | Before 1.0.0 | From 1.0.0 |
|---|---|---|
| Breaks something people or other servers rely on | MINOR (0.x → 0.x+1) | MAJOR |
| New feature | MINOR | MINOR |
| Fix only | PATCH | PATCH |

While the version starts with `0.`, nothing is stable yet and every release is marked a pre-release.

This is applied to **every change, strictly**: no pull request merges without a CHANGELOG.md line, and `changelog.py check` works the next version out from the lines and refuses any other:

| Lines in the release | Next version, before 1.0.0 | From 1.0.0 |
|---|---|---|
| any `### Removed`, or a line that says BREAKING | MINOR | MAJOR |
| any `### Added`, `### Changed` or `### Deprecated` | MINOR | MINOR |
| only `### Fixed` or `### Security` | PATCH | PATCH |

A release adds exactly one dated section, right after an emptied `## [Unreleased]`, higher than the last release; released sections are never edited. Moving from 0.x to 1.0.0 is the maintainers' call and always allowed. The `release` workflow also refuses a tag that is not higher than every earlier tag. A pull request that only bumps a dependency (Dependabot) still gets a line, under `### Security` or `### Fixed`, which a maintainer adds before merging.

## 4. Cutting a release

1. Open a pull request that moves the `## [Unreleased]` lines into a new `## [X.Y.Z] - YYYY-MM-DD` section and updates the links at the bottom. Review and merge it like any other.
2. Tag the merged commit on `main` and push the tag (only maintainers can create `v*` tags):
   ```
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
3. The `release` workflow checks that the commit is on `main`, runs the leak check over the whole history, takes the notes from CHANGELOG.md and publishes the GitHub Release. If any step fails, no release is published.

Tags can never be moved or deleted. A bad release is fixed by a new PATCH release, never by retagging.
