// The runtime deprecation warning of the 0.x entry, drizzle-cubrid/legacy
// (ADR 0010). It is emitted once per process when that entry is loaded, and
// never by the root entry or drizzle-cubrid/native, which do not import this
// module.

/** The `code` of the warning, for `process.on('warning')` filters and `--disable-warning`. */
export const LEGACY_DEPRECATION_CODE = 'DRIZZLE_CUBRID_LEGACY';

export const LEGACY_DEPRECATION_MESSAGE =
	'drizzle-cubrid/legacy is the 0.x API built on Drizzle’s MySQL classes. It is deprecated and will be ' +
	'removed in drizzle-cubrid 1.0. Import the CUBRID-native API from "drizzle-cubrid" instead; see ' +
	'https://github.com/cubrid-lab/drizzle-cubrid/blob/main/docs/MIGRATING_FROM_0X.md';

type NodeEmitWarning = (message: string, options: { type: string; code: string }) => void;

// A global flag, not a module variable: the ESM and CJS builds of the legacy
// entry are two module instances, and a process that loads both still warns once.
const WARNED = Symbol.for('drizzle-cubrid.legacy-deprecation-warned');

/**
 * Emits the deprecation warning unless this process already did. Node's
 * `--no-deprecation` silences it, `--trace-deprecation` adds a stack trace,
 * and `--throw-deprecation` makes Node throw it on the next tick, as an
 * uncaught exception that ends the process (not catchable around the import;
 * use `process.on('warning')` for that), as for Node's own deprecations.
 */
export function emitLegacyDeprecationWarning(): void {
	const flags = globalThis as { [WARNED]?: boolean };
	if (flags[WARNED]) return;
	flags[WARNED] = true;
	// The repository has no @types/node (see src/native/node-builtins.d.ts).
	const { process } = globalThis as { process?: { emitWarning?: NodeEmitWarning } };
	if (typeof process?.emitWarning !== 'function') return;
	process.emitWarning(LEGACY_DEPRECATION_MESSAGE, { type: 'DeprecationWarning', code: LEGACY_DEPRECATION_CODE });
}
