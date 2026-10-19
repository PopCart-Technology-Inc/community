# Rules for every session (people and AI agents)

## 0. THIS REPOSITORY IS PUBLIC. SECURITY AND LEAKS COME FIRST, ALWAYS.

Everything committed here is published to the whole internet and stays in the history forever, even after it is deleted. Before any feature, style or speed concern, every change must answer: **does this leak anything?**

**Never commit, push, paste into an issue, or write in a commit message:**
- secrets of any kind: keys, tokens, passwords, certificates, `.env` files, connection strings;
- personal data: real people's names with contact details, phone numbers, emails, addresses, IDs, photos;
- internal details of PopCart Technologies: server names, hostnames, IP addresses, local paths, closed repositories, internal tools, internal decision IDs, ops or deploy steps;
- code, data or brand art copied from PopCart's closed products. Only the public interface (signed credentials) belongs here.

**The checks (all must pass; none may be skipped):**
1. **Once per clone:** `git config core.hooksPath .githooks`
2. **pre-commit:** `tools/leakcheck/leakcheck.py --staged` checks what you are about to commit.
3. **pre-push:** `--pre-push` checks every commit leaving your machine, including commit messages.
4. **CI** (`.github/workflows/leakcheck.yml`): leakcheck plus gitleaks over the **whole history** on every push and pull request.
5. **GitHub:** secret scanning with push protection is on. `main` takes changes only through a squash-merged pull request with green checks (`leakcheck`, `dco`) and a maintainer's approving review; force pushes and deletion are blocked. Release tags (`v*`) can only be created by maintainers and can never be moved or deleted. Workflow runs from outside contributors wait for a maintainer's approval, and actions must be pinned to a full commit SHA.
6. **Claude Code sessions:** `.claude/settings.json` runs `tools/leakcheck/session_guard.py` before every shell command. It blocks `--no-verify`, force pushes, hook changes, and pushes from a clone with the hooks off.

**Private names** (servers, hosts, closed repos) are checked from a list kept **outside** this repo (`~/.config/popcart/leakcheck-private.txt`, and the `LEAKCHECK_PRIVATE` Actions secret). Never add that list, or any of its terms, to this repo.

**If something leaks:** treat it as public. Rotate the secret first, then remove it from history, then report it to support.popcart@gmail.com with "SECURITY" in the subject. Do not just delete it in a new commit.

## 1. How to change things
- Work on a branch, push the branch, open a pull request. `main` only moves through reviewed, green pull requests: checks `leakcheck` and `dco`, an approving review from a code owner, then a squash merge.
- Never merge your own pull request around the review unless the human maintainer tells you to for that pull request.
- **Golden rule: Semantic Versioning is applied to every change, strictly, with no exceptions.** Every pull request adds a line under `## [Unreleased]` in CHANGELOG.md (### Added, Changed, Fixed, Removed or Security), and every release is the last version bumped by what those lines say (docs/RELEASING.md, "Versions").
- `tools/ci/changelog.py check` enforces it in the pre-push hook and in the required `dco` check; a pull request without a line, or a release with the wrong version, cannot merge. Never weaken or skip it.
- Released sections are never edited; a mistake is fixed by a new PATCH release. Releases are `v*` tags cut by maintainers (docs/RELEASING.md); never create a tag unless the human maintainer asks for that release, and never move or delete one.
- Sign off every commit (`git commit -s`, see CONTRIBUTING.md).
- Follow the data rule in `docs/decisions/0001-hold-keys-not-data.md`.
- No fake data in the product: show live values with the time they were read; label examples in designs and docs.
