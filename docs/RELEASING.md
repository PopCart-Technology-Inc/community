# Reviews and releases

How a change gets from a contributor's pull request into a released version. Written for maintainers; contributors start with [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. The path of a pull request

```
fork or branch → pull request → checks → maintainer review → squash merge → Unreleased → release tag
```

1. **Checks run** on every pull request. Both must be green:
   - `leakcheck`: our scanner and gitleaks over the whole history;
   - `dco`: every commit is signed off by its author.
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
