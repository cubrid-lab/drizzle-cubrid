# Release Please: preparing a reviewed release

Release Please proposes the next `drizzle-cubrid` version through a pull request. It **does not publish to npm, create a Git tag, or create a GitHub Release**. The existing `.github/workflows/publish.yml` still runs its package, Node 18 and live CUBRID gates on `v*` tags. See [ADR 0001](adr/0001-release-governance.md) and [release policy](RELEASE_POLICY.md).

## Baseline and version decisions

- Baseline is the existing, immutable `v0.2.1` release. `.release-please-manifest.json`, `package.json` and `package-lock.json` all start at `0.2.1`. Do not re-tag or re-publish existing versions.
- `release-please-config.json` uses the Node package strategy for the root package, without a component prefix, retaining `vX.Y.Z` tags. Before 1.0, compatible fixes generally bump PATCH; additive changes or explicit breaking changes require a reviewed MINOR with migration notes. Release Please's computed version is only a **proposal**, not an approval of public API or SQL compatibility.
- The generator runs on pushes to `main`, or by manual workflow dispatch, only when the **current** manifest version has a GitHub Release, tag and npm package. A missing/partial publication blocks the next release PR; investigate and recover the existing immutable version first.
- GitHub Release descriptions use the reviewed editorial source `docs/releases/vX.Y.Z.md`, not automatically generated commit bullets in the changelog. Preserve existing release history and contributor attribution.

## Required maintainer release sequence

1. Review the Release Please PR's proposed version, `package.json`, `package-lock.json`, manifest and `CHANGELOG.md`. Check commit classification and supported `drizzle-orm`/`cubrid-client` peers. Correct the proposed version before merge where needed. Do not release 1.0 automatically.
2. Create and independently review the matching curated `docs/releases/vX.Y.Z.md` with compatibility, upgrade/migration information, checked credits and changelog links. Run `python3 scripts/release_notes_quality.py` and its regression test. A generated changelog is a draft, not the public Release body.
3. Run the required exact-candidate verification on the final reviewed commit and actual package artifact (live CUBRID, Node 18, tested peer floors, lint, typecheck and relevant security checks). Merge the Release PR only after required review/CI. **Merging alone is not permission to publish**.
4. After explicitly approving publication, create an **immutable** `vX.Y.Z` tag at the reviewed candidate commit, only if the tag/npm version do not already exist. The separate tag-triggered `publish.yml` verifies the same packaged release candidate and publishes to npm only if its release jobs pass. Check registry, GitHub Release and tag afterwards.
5. Confirm the GitHub Release body matches the reviewed `docs/releases/vX.Y.Z.md`. After both the GitHub and npm release are verified, clear any stale `autorelease: pending` label on the merged Release Please PR before generating another version. Do not silently move or overwrite existing tags.

## GitHub token and checks

Configure a restricted `RELEASE_PLEASE_TOKEN` repository secret with permission to open/update PRs if automatic PR CI is desired. Without it, the workflow falls back to `GITHUB_TOKEN`, whose bot-created PRs **do not trigger** `pull_request` workflows. In that case, arrange for required CI to run and pass on the final release PR head through a separately authorized actor before merging; never treat missing checks as green.

This adoption only adds release-**proposal** automation. Hardening the tag-to-publication authorization and making historical release-body synchronization safe are separate reviewed changes; neither is implied by this workflow.
