# Release process

This npm package uses [Release Please](https://github.com/googleapis/release-please) (release type **node**) to **propose** each release in a reviewed pull request. Release Please never tags, creates a GitHub Release or publishes: tagging stays a manual maintainer step, and the tag runs the existing release gate in `.github/workflows/publish.yml`. The rules a release must satisfy are in [RELEASE_POLICY.md](RELEASE_POLICY.md).

## Files

| File | Role |
| --- | --- |
| `.github/workflows/release-please.yml` | On every push to `main` (or a manual run), creates or updates the Release PR. PR-only: `skip-github-release: true`. |
| `release-please-config.json` | One package at the repository root, release type `node`, tags `vX.Y.Z` (no component), `bump-minor-pre-major: true`. |
| `.release-please-manifest.json` | The last released version. It started at `0.2.1`, the published npm version and the `v0.2.1` tag; historical tags are never recreated. |
| `.github/workflows/pr-title.yml` | Fails a PR whose title is not a Conventional Commits title. |
| `.github/labels.yml` | Includes the `autorelease: pending` and `autorelease: tagged` labels Release Please uses. |
| `.github/workflows/publish.yml` | Runs only on a pushed `v*` tag, gates the packed tarball on live CUBRID 11.4 and the Node 18 consumer, publishes it with npm trusted publishing from the `npm-publish` environment and creates the GitHub Release. |

## How versions are chosen

Release Please reads the commit subjects on `main`. With the [required merge settings](#repository-settings) (squash merge only, commit title = PR title), the subject is the PR title, which `.github/workflows/pr-title.yml` checks: `type: description` or `type(scope): description`, with a type from `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

| Commit on `main` | Next version while 0.x | From 1.0.0 |
| --- | --- | --- |
| `fix:`, `perf:`, `revert:` | patch (0.2.1 → 0.2.2) | patch |
| `feat:` | minor (0.2.1 → 0.3.0) | minor |
| `feat!:`, `fix!:` or a `BREAKING CHANGE:` footer | **minor** (0.2.1 → 0.3.0) | major |
| `docs:`, `style:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:` | no release on their own, not listed in the CHANGELOG | same |

`bump-minor-pre-major: true` makes a breaking change before 1.0 a minor bump, as [RELEASE_POLICY.md](RELEASE_POLICY.md#version-numbers) requires ("MINOR with explicit migration notes"). Without it Release Please would turn the first breaking change into 1.0.0, which the [1.0 release gate](RELEASE_POLICY.md#10-release-gate) does not allow yet. 1.0.0 is chosen deliberately, for example with a `Release-As: 1.0.0` commit footer, once that gate is met.

**Silently dropped commits.** Release Please's commit parser throws on some commit bodies, for example a line that starts with a nested call such as `where(eq(...` (the squash body of #209, `fix: read cubrid-client Date values in date and time columns`). Such a commit is left out of the version calculation and the CHANGELOG without an error. The blank squash message setting below (instead of the list of branch commits) makes this less likely; reviewers still compare the Release PR's entries with the PRs merged since the last release and add anything missing by hand.

## CHANGELOG ownership

From the adoption of Release Please on, **PRs do not edit `CHANGELOG.md`**. Release Please writes the version section from the Conventional Commit subjects merged since the last release. Describe user-visible changes, upgrade steps and breaking changes in the PR title and description instead; type `BREAKING CHANGE: <what to do>` into the blank squash commit body while merging if a breaking change needs an explanation in the changelog.

The `## [Unreleased]` section that already exists in `CHANGELOG.md` was curated by hand for the coming breaking release (Upgrade notes, Deprecated, Added, Fixed, Changed) and is kept. Release Please inserts its generated section **above** `## [Unreleased]`, so the first Release PR contains both. The maintainer folds them into one section as the **last edit before merging** (see step 4 below):

1. Check out the Release PR's head branch (`release-please--branches--main--components--drizzle-cubrid`).
2. Move the curated subsections under the generated `## [0.3.0](...) (date)` heading, keep the curated text where it describes the same change as a generated bullet (do not list a change twice), and delete the `## [Unreleased]` heading. While there, remove generated items that are not user-visible, such as `fix(ci):` entries and the bogus `[@v1](https://github.com/v1)` / `[@v0](https://github.com/v0)` user links Release Please makes from action versions in commit subjects, and add any commit the parser dropped (#209 for 0.3.0).
3. Push, review the diff, and merge **promptly**. A later push to `main` can make Release Please regenerate the branch and discard the edit (when a new releasable commit lands or the UTC date in the heading changes); redo the fold if that happens.

Later Release PRs need no fold, but the same review applies. `CHANGELOG.md` has no 0.2.0 or 0.2.1 sections ([RELEASE_NOTES_AUDIT.md](RELEASE_NOTES_AUDIT.md)); do not invent them.

## Releasing

1. **Release PR.** After a releasable commit lands on `main`, the workflow opens `chore(main): release X.Y.Z` from the head branch `release-please--branches--main--components--drizzle-cubrid`. It bumps `package.json`, `package-lock.json`, `.release-please-manifest.json` and `CHANGELOG.md`. A version is not released because the PR exists.
2. **CI on the Release PR.** The PR changes `package.json`, so `ci.yml` classifies it as a full (not docs-only) change and runs lint, typecheck, tests with coverage, the live CUBRID 11.4 and fault-injection suites, the packed-tarball live suite with lockfile and floor peers, and the Node 18 consumer. That is the same evidence `publish.yml` requires, on the candidate commit. **When the PR was created with `GITHUB_TOKEN`, no CI runs automatically** (GitHub does not trigger workflows from `GITHUB_TOKEN` events): close and reopen the PR so the checks run. Never merge with a failed, skipped or missing required check.
3. **Release notes first.** Write the curated `docs/releases/vX.Y.Z.md` ([RELEASE_NOTES_QUALITY.md](RELEASE_NOTES_QUALITY.md)), with migration notes for breaking changes, in a separate `docs:` PR and merge it. This push to `main` can regenerate the Release PR (when a new releasable commit lands or the UTC date changes), which is why the fold comes after it.
4. **Fold and review.** For the first Release PR, fold the `[Unreleased]` section as described above; for every Release PR, check the generated entries against the merged PRs. This is the last edit before merging.
5. **Merge** the Release PR (squash; the title stays `chore(main): release X.Y.Z`). Merging only changes `main`: `publish.yml` runs on tags, so nothing is published.
6. **Before tagging,** run the provenance check and the similarity scan in [PROVENANCE.md](PROVENANCE.md#rerun-before-a-release) on the merge commit.
7. **Tag** the merge commit on `main` and push the tag: `git tag vX.Y.Z <merge-sha> && git push origin vX.Y.Z`. `publish.yml` checks the tag against `package.json`, runs its gate, publishes the tested tarball to npm and then creates the GitHub Release with generated notes.
8. **Publish the curated notes.** Because `docs/releases/vX.Y.Z.md` was merged before the GitHub Release existed, run **Actions → Synchronize reviewed GitHub Release notes → Run workflow**; it replaces the generated body with the reviewed note. Check the public Release page.
9. **Release PR label.** On the next run (any push to `main`, or **Run workflow** on "Prepare reviewed Release PR"), once `X.Y.Z` is on npm and has a non-draft GitHub Release, the workflow removes `autorelease: pending` from the merged `chore(main): release X.Y.Z` PR and adds `autorelease: tagged`. Release Please refuses to open the next Release PR while a merged one keeps `autorelease: pending`; if the automatic step ever fails, remove that label by hand: `gh pr edit <number> --remove-label "autorelease: pending"`.

The workflow refuses to propose a newer version until the version in `package.json` on `main` has **both** a non-draft GitHub Release `vX.Y.Z` and the exact npm version `drizzle-cubrid@X.Y.Z`. Between steps 5 and 7 it therefore logs a notice and does nothing; if it cannot read the GitHub Release (an API error rather than "not found"), it logs a warning and also does nothing.

### Recovering a failed publish

`publish.yml` runs only on the tag push; it has no manual trigger. Never skip to a new version to work around a failed publish.

- **npm does not have `X.Y.Z`** (a gate job or `npm publish` failed): fix the cause outside the tagged code (for example a secret or a flaky service), then open the failed `publish.yml` run and use **Re-run failed jobs**. It runs against the same tag. If the tagged code itself is wrong, do not move the tag; release the next patch version by hand, as below.
- **Replacing a version that never reached npm.** The workflow cannot propose the next version while `X.Y.Z` is missing from npm (its guard stays false), so make the replacement release by hand: (1) fix the code in ordinary PRs; (2) open a PR titled `chore(main): release X.Y.Z+1` that sets the version to `X.Y.Z+1` in `package.json`, both version fields of `package-lock.json` and `.release-please-manifest.json`, and adds a `CHANGELOG.md` section for `X.Y.Z+1` that states `X.Y.Z` was tagged but never published, plus a `docs/releases/vX.Y.Z+1.md` note (or a separate notes PR first); (3) after review and CI, merge it and tag the merge commit `vX.Y.Z+1`, which runs `publish.yml`; (4) remove `autorelease: pending` from the `X.Y.Z` Release PR by hand (`gh pr edit <number> --remove-label "autorelease: pending"`), because the automatic step only clears the PR of the version that was published. Leave the `vX.Y.Z` tag in place and do not create a GitHub Release for it.
- **npm has `X.Y.Z` but there is no GitHub Release** (the last step failed): do not re-run the publish job, because npm refuses to publish the same version twice. Create the Release from the existing tag: `gh release create vX.Y.Z --verify-tag --title "drizzle-cubrid vX.Y.Z" --notes-file docs/releases/vX.Y.Z.md`.

## Repository settings

These are settings in the repository, not files.

- **Required merge settings (current values; keep them).** Settings → General → Pull Requests: squash merging only (`allow_squash_merge=true`, `allow_merge_commit=false`, `allow_rebase_merge=false`), with the squash commit title set to the **Pull request title** and the squash commit message **blank** (`squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=BLANK`). The title is then always the checked PR title, and the body holds only what the person merging types in, such as a `BREAKING CHANGE:` or `Release-As:` footer, so Release Please reads the right type and does not trip over a list of branch commits. Do not re-enable merge commits or rebase merging: they bypass the PR-title check. Changing these settings back (for example to `COMMIT_OR_PR_TITLE`, where a single-commit PR keeps its commit subject instead of the PR title) breaks the assumptions of this process.
- **Recommended:** make the `Check PR title` check required in the branch protection or ruleset for `main`.
- **Settings → Actions → General → Workflow permissions:** "Allow GitHub Actions to create and approve pull requests" must stay enabled, or the workflow cannot open the Release PR.
- **Labels:** `autorelease: pending` and `autorelease: tagged` come from `.github/labels.yml` and are created by the label sync workflow when this change lands on `main`.
- **npm trusted publishing.** `publish.yml` publishes without a stored npm token: its `publish` job runs in the `npm-publish` environment (deployments limited to `v*` tags) with `id-token: write`, and npm 11.5.1 or later exchanges the job's OIDC identity for a short-lived credential. On npmjs.com, the package's **Settings → Trusted Publisher** must name GitHub Actions with `cubrid-lab` / `drizzle-cubrid` / `publish.yml` / environment `npm-publish`; renaming the workflow file or the environment breaks publishing until it is updated there. Versions published this way carry an npm provenance attestation.
- **Optional `RELEASE_PLEASE_TOKEN` secret:** a fine-grained token limited to this repository (Contents and Pull requests: read and write). With it, the Release PR triggers CI automatically. Without it the workflow falls back to `GITHUB_TOKEN` and CI must be started by closing and reopening the PR (step 2). A GitHub App token minted per run is an alternative; do not store an expiring App token as a long-lived secret.
