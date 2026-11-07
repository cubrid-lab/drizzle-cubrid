import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function trackedPaths(): string[] {
  // A NUL separator handles spaces/newlines in Git paths safely.
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

describe('portable repository checkout', () => {
  it('does not track paths that collide on case-insensitive file systems', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];

    for (const path of trackedPaths()) {
      // Normalize Unicode and case, as required for common Windows/macOS checkouts.
      const key = path.normalize('NFC').toLowerCase();
      const earlier = seen.get(key);
      if (earlier && earlier !== path) {
        conflicts.push(`${earlier} <=> ${path}`);
      } else {
        seen.set(key, path);
      }
    }

    expect(conflicts).toEqual([]);
  });

  it('has exactly one canonical GitHub pull request template', () => {
    const templates = trackedPaths().filter((path) =>
      /^\.github\/pull_request_template\.md$/i.test(path),
    );
    expect(templates).toEqual(['.github/pull_request_template.md']);
  });
});
