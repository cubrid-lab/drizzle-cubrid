// Placeholders for the 0.x root exports that the CUBRID-native root entry has
// no direct counterpart for (ADR 0010). Until 0.3 the root entry was the 0.x
// API; code that still imports one of these names from 'drizzle-cubrid' gets
// a message naming the replacement instead of a bare `undefined`:
//
// - TypeScript: the value has the type `RemovedFromRoot<'…message…'>`, which is
//   not callable, so a call fails to compile and the error prints the message.
// - At run time: calling, constructing or `instanceof` throws the message.
//
// The names Drizzle's MySQL builders use (mysqlEnum) are left out: native code
// may not contain them (scripts/check-dialect-boundary.mjs); importing them
// from the root fails as an unknown export. The placeholders are removed in
// 1.0 together with drizzle-cubrid/legacy.

const MIGRATION_GUIDE = 'https://github.com/cubrid-lab/drizzle-cubrid/blob/main/docs/MIGRATING_FROM_0X.md';

declare const removedFromRoot: unique symbol;

/** The type of a 0.x export that is not in the root entry since 0.3; `Message` says what to use. */
export interface RemovedFromRoot<Message extends string> {
	readonly [removedFromRoot]: Message;
}

/** The error a removed 0.x export throws when it is used at run time. */
export class CubridRemovedExportError extends Error {
	override readonly name = 'CubridRemovedExportError';
	/** The 0.x export that was used. */
	readonly exportName: string;

	constructor(exportName: string, message: string) {
		super(message);
		this.exportName = exportName;
	}
}

function removed<const Message extends string>(exportName: string, message: Message): RemovedFromRoot<Message>;
function removed(exportName: string, message: string): object {
	const full = `${message} See ${MIGRATION_GUIDE}`;
	// A function expression, not an arrow function, so that `new` reaches it too.
	const fail = function removedExport(): never {
		throw new CubridRemovedExportError(exportName, full);
	};
	Object.defineProperty(fail, 'name', { value: exportName });
	Object.defineProperty(fail, Symbol.hasInstance, { value: fail });
	return fail;
}

/** @deprecated Not in the root entry since 0.3: use `set({ element })`, or `cubridSet` from `drizzle-cubrid/legacy` (removed in 1.0). */
export const cubridSet = removed(
	'cubridSet',
	"drizzle-cubrid: cubridSet() is a 0.x export that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use set({ element }) from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `multiset({ element })`, or `cubridMultiset` from `drizzle-cubrid/legacy` (removed in 1.0). */
export const cubridMultiset = removed(
	'cubridMultiset',
	"drizzle-cubrid: cubridMultiset() is a 0.x export that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use multiset({ element }) from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `sequence({ element })`, or `cubridSequence` from `drizzle-cubrid/legacy` (removed in 1.0). */
export const cubridSequence = removed(
	'cubridSequence',
	"drizzle-cubrid: cubridSequence() is a 0.x export that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use sequence({ element }) from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: the native API has no custom types. `customType` is in `drizzle-cubrid/legacy` (removed in 1.0). */
export const customType = removed(
	'customType',
	"drizzle-cubrid: customType() is a 0.x export that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). The native API has no custom-type facility; use a built-in builder or raw sql.",
);
/** @deprecated Not in the root entry since 0.3: CUBRID has no 8-bit integer; use `smallint()`. */
export const tinyint = removed(
	'tinyint',
	"drizzle-cubrid: tinyint() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). CUBRID has no 8-bit integer: use smallint() from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `integer()`. */
export const mediumint = removed(
	'mediumint',
	"drizzle-cubrid: mediumint() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use integer() from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `bigint({ mode: 'bigint' }).primaryKey().autoIncrement()`. */
export const serial = removed(
	'serial',
	"drizzle-cubrid: serial() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use bigint({ mode: 'bigint' }).primaryKey().autoIncrement() from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `smallint()`. */
export const year = removed(
	'year',
	"drizzle-cubrid: year() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use smallint() from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `double()`. */
export const real = removed(
	'real',
	"drizzle-cubrid: real() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use double() from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `string()` or `varchar({ length })`. */
export const text = removed(
	'text',
	"drizzle-cubrid: text() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use string() or varchar({ length }) from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `string()` or `varchar({ length })`. */
export const tinytext = removed(
	'tinytext',
	"drizzle-cubrid: tinytext() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use string() or varchar({ length }) from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `string()` or `varchar({ length })`. */
export const mediumtext = removed(
	'mediumtext',
	"drizzle-cubrid: mediumtext() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use string() or varchar({ length }) from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: use `string()` or `varchar({ length })`. */
export const longtext = removed(
	'longtext',
	"drizzle-cubrid: longtext() is a 0.x (MySQL) builder that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use string() or varchar({ length }) from 'drizzle-cubrid'.",
);
/** @deprecated Not in the root entry since 0.3: call `prepare()` on a query; it returns `CubridPreparedSelect`, `CubridPreparedWrite` or `CubridPreparedRelationalQuery`. */
export const CubridPreparedQuery = removed(
	'CubridPreparedQuery',
	"drizzle-cubrid: CubridPreparedQuery is a 0.x class that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). prepare() of the native API returns CubridPreparedSelect, CubridPreparedWrite or CubridPreparedRelationalQuery.",
);
