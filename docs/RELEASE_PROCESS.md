# Release process

This npm package uses [Release Please](https://github.com/googleapis/release-please) (release type **node**) to **propose** each release in a reviewed pull request. Release Please never tags, creates a GitHub Release or publishes: tagging stays a manual maintainer step, and the tag runs the existing release gate in `.github/workflows/publish.yml`. The rules a release must satisfy are in [RELEASE_POLICY.md](RELEASE_POLICY.md).

## Files

| File | Role |
| --- | --- |
| `.github/workflows/release-please.yml` | On every push to `main` (or a manual run), creates or updates the Release PR. PR-only: `skip-github-release: true`. |
| `release-please-config.json` | One package at the repository root, release type `node`, tags `vX.Y.Z` (no component), `bump-minor-pre-major: true`. |
| `.release-please-manifest.json` | The last released version. It started at `0.2.1`, the published npm version and the `v0.2.1` tag; historical tags are never recreated. |
| `.github/workflows/pr-title.yml` | Fails a PR whose title is not a Conventional Commits title. |
| `.github/workflows/publish.yml` | Unchanged: runs only on a pushed `v*` tag, gates the packed tarball on live CUBRID 11.4 and the Node 18 consumer, publishes it and creates the GitHub Release. |

## How versions are chosen

PRs are squash-merged, so the PR title becomes the commit subject that Release Please reads. `.github/workflows/pr-title.yml` requires `type: description` or `type(scope): description`, with a type from `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

| Commit on `main` | Next version while 0.x | From 1.0.0 |
| --- | --- | --- |
| `fix:` | patch (0.2.1 → 0.2.2) | patch |
| `feat:` | minor (0.2.1 → 0.3.0) | minor |
| `feat!:`, `fix!:` or a `BREAKING CHANGE:` footer | **minor** (0.2.1 → 0.3.0) | major |
| `docs:`, `test:`, `ci:`, `chore:` and the rest | no release on their own | same |

`bump-minor-pre-major: true` makes a breaking change before 1.0 a minor bump, as [RELEASE_POLICY.md](RELEASE_POLICY.md#version-numbers) requires ("MINOR with explicit migration notes"). Without it Release Please would turn the first breaking change into 1.0.0, which the [1.0 release gate](RELEASE_POLICY.md#10-release-gate) does not allow yet. 1.0.0 is chosen deliberately, for example with a `Release-As: 1.0.0` commit footer, once that gate is met.

## CHANGELOG ownership

From the adoption of Release Please on, **PRs do not edit `CHANGELOG.md`**. Release Please writes the version section from the Conventional Commit titles merged since the last release. Describe user-visible changes, upgrade steps and breaking changes in the PR title and description instead; put `BREAKING CHANGE: <what to do>` in the squash commit body when a breaking change needs an explanation in the changelog.

The `## [Unreleased]` section that already exists in `CHANGELOG.md` was curated by hand for the coming breaking release (Upgrade notes, Deprecated, Added, Fixed, Changed) and is kept. Release Please inserts its generated section **above** `## [Unreleased]`, so the first Release PR contains both. Before merging that PR, the maintainer folds them into one section:

1. Check out the Release PR branch (`release-please--branches--main`).
2. Move the curated subsections under the generated `## [0.3.0](...) (date)` heading, keep the curated text where it describes the same change as a generated bullet (do not list a change twice), and delete the `## [Unreleased]` heading.
3. Push, review the diff, and merge **promptly**. Any later push to `main` makes Release Please regenerate the branch and discard the edit; redo the fold if that happens.

Later Release PRs need no manual CHANGELOG work. `CHANGELOG.md` has no 0.2.0 or 0.2.1 sections ([RELEASE_NOTES_AUDIT.md](RELEASE_NOTES_AUDIT.md)); do not invent them.

## Releasing

1. **Release PR.** After a releasable commit lands on `main`, the workflow opens `chore(main): release X.Y.Z`. It bumps `package.json`, `package-lock.json`, `.release-please-manifest.json` and `CHANGELOG.md`. A version is not released because the PR exists.
2. **CI on the Release PR.** The PR changes `package.json`, so `ci.yml` classifies it as a full (not docs-only) change and runs lint, typecheck, tests with coverage, the live CUBRID 11.4 and fault-injection suites, the packed-tarball live suite with lockfile and floor peers, and the Node 18 consumer. That is the same evidence `publish.yml` requires, on the candidate commit. **When the PR was created with `GITHUB_TOKEN`, no CI runs automatically** (GitHub does not trigger workflows from `GITHUB_TOKEN` events): close and reopen the PR, or push a commit to it, so the checks run. Never merge with a failed, skipped or missing required check.
3. **Release notes.** Write the curated `docs/releases/vX.Y.Z.md` ([RELEASE_NOTES_QUALITY.md](RELEASE_NOTES_QUALITY.md)) in a separate `docs:` PR. Fold the `[Unreleased]` section for the first Release PR as described above.
4. **Merge** the Release PR (squash; the title stays `chore(main): release X.Y.Z`). Merging only changes `main`: `publish.yml` runs on tags, so nothing is published.
5. **Tag** the merge commit on `main` and push the tag: `git tag vX.Y.Z <merge-sha> && git push origin vX.Y.Z`. `publish.yml` checks the tag against `package.json`, runs its gate, publishes the tested tarball and creates the GitHub Release with generated notes.
6. **Publish the curated notes.** If `docs/releases/vX.Y.Z.md` was merged before the GitHub Release existed, run **Actions → Synchronize reviewed GitHub Release notes → Run workflow**; it replaces the generated body with the reviewed note. Check the public Release page.
7. **Mark the Release PR as released.** Release Please labels its PR `autorelease: pending` and refuses to open the next Release PR while a merged PR keeps that label. After npm and the GitHub Release show `X.Y.Z`, replace the label: `gh pr edit <number> --remove-label "autorelease: pending" --add-label "autorelease: tagged"`.

The workflow also refuses to propose a newer version until the version in `package.json` on `main` has **both** a GitHub Release `vX.Y.Z` and the exact npm version `drizzle-cubrid@X.Y.Z`. Between steps 4 and 6 it therefore logs a notice and does nothing. If the tag exists but npm publication failed, fix the cause and rerun `publish.yml` for that same tag; never skip to a new version to work around a failed publish.

## Repository settings

- **Settings → Actions → General → Workflow permissions:** "Allow GitHub Actions to create and approve pull requests" must stay enabled, or the workflow cannot open the Release PR.
- **Optional `RELEASE_PLEASE_TOKEN` secret:** a fine-grained token limited to this repository (Contents and Pull requests: read and write). With it, the Release PR triggers CI automatically. Without it the workflow falls back to `GITHUB_TOKEN` and CI must be started by hand (step 2). A GitHub App token minted per run is an alternative; do not store an expiring App token as a long-lived secret.
