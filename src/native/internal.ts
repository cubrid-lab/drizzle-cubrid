// The only place native code touches Drizzle internals (ADR 0007, decision 2).
//
// Every accessor below names the drizzle-orm file it depends on and the
// versions it was checked against. Outside this file, native code may not use
// `Symbol.for('drizzle:…')`, `.decoder`, `.shouldDisableInsert`, `setName` or
// any cast through `unknown`, `any` or `never`; scripts/check-dialect-boundary.mjs
// enforces that.

import { Column } from 'drizzle-orm/column';
import { is } from 'drizzle-orm/entity';
import {
	type BuildQueryConfig,
	type DriverValueDecoder,
	Param,
	Placeholder,
	type Query,
	SQL,
	type SQLChunk,
	StringChunk,
	sql,
} from 'drizzle-orm/sql/sql';
import type { Table } from 'drizzle-orm/table';

// drizzle-orm/table.js: `Table.Symbol.Columns` and `Table.Symbol.ExtraConfigColumns`
// are `Symbol.for('drizzle:Columns')` and `Symbol.for('drizzle:ExtraConfigColumns')`.
// `Table.Symbol` is `@internal` and the keys are not in table.d.ts. Drizzle's
// neutral `getTableColumns()`, SQL rendering (sql/sql.js) and relations read
// them. Checked against drizzle-orm 0.44.1 and 0.45.4.
const TableColumns = Symbol.for('drizzle:Columns');
const TableExtraConfigColumns = Symbol.for('drizzle:ExtraConfigColumns');

/** Registers a table's built columns where Drizzle's neutral modules look for them. */
export function setTableColumns(table: Table, columns: Record<string, Column>): void {
	const slots = table as unknown as Record<symbol, unknown>;
	slots[TableColumns] = columns;
	slots[TableExtraConfigColumns] = columns;
}

// drizzle-orm/column-builder.js: `ColumnBuilder#setName(name)` is `@internal`
// and not in column-builder.d.ts. It sets `config.name` only when the builder
// was created without a name (`keyAsName`). Checked against drizzle-orm 0.44.1
// and 0.45.4.
/** Gives a builder created without a name its key in the table definition. */
export function setColumnBuilderName(builder: object, name: string): void {
	(builder as unknown as { setName(name: string): void }).setName(name);
}

// drizzle-orm/sql/sql.js: `SQL#decoder` is `@internal`; the public
// `sql\`...\`.mapWith(decoder)` sets it and it defaults to a no-op decoder.
// Drizzle's own row mapping reads it the same way. Checked against
// drizzle-orm 0.44.1 and 0.45.4.
/** The decoder `mapWith()` gave a `sql` expression, or undefined when there is none. */
// biome-ignore lint/suspicious/noExplicitAny: decoders are any-typed in Drizzle's declarations too.
export function getSqlDecoder(query: SQL): DriverValueDecoder<unknown, any> | undefined {
	const decoder = (query as unknown as { decoder?: unknown }).decoder;
	return typeof decoder === 'object' && decoder !== null && 'mapFromDriverValue' in decoder
		? (decoder as DriverValueDecoder<unknown, unknown>)
		: undefined;
}

// drizzle-orm/table.js and alias.js: `Table.Symbol.IsAlias` and
// `Table.Symbol.OriginalName` are `Symbol.for('drizzle:IsAlias')` and
// `Symbol.for('drizzle:OriginalName')`, `@internal` and not in table.d.ts.
// Drizzle's public `aliasedTable(table, alias)` returns a proxy whose IsAlias
// is true, whose name is the alias and whose OriginalName stays the table's
// name; Drizzle's own dialects read both to write `"table" "alias"` in FROM.
// Checked against drizzle-orm 0.44.1 and 0.45.4.
const TableIsAlias = Symbol.for('drizzle:IsAlias');
const TableOriginalName = Symbol.for('drizzle:OriginalName');

/** The real table name of a table made with `aliasedTable()`, or undefined for a table that is not an alias. */
export function getAliasedTableOriginalName(table: Table): string | undefined {
	const slots = table as unknown as Record<symbol, unknown>;
	const original = slots[TableOriginalName];
	return slots[TableIsAlias] === true && typeof original === 'string' ? original : undefined;
}

// drizzle-orm/sql/sql.js: for each bound `Param`, `SQL#buildQueryFromSourceParams()`
// calls `prepareTyping(param.encoder)` (when given) and then, in the same
// step, `escapeParam(index, mappedValue)`. It calls only `escapeParam` for a
// placeholder and neither for an inlined value. Checked against drizzle-orm
// 0.44.1 and 0.45.4.
/**
 * `toQuery()` callbacks with which `placeholder` sees the encoder (usually the
 * column) of each value it writes a placeholder for; undefined for a
 * `sql.placeholder()`. src/dialect.ts inlines the same tracking for the 0.x
 * API, which may not share a module with this entry; change both.
 */
export function escapeParamWithEncoder(
	placeholder: (encoder: unknown, value: unknown) => string,
): Pick<BuildQueryConfig, 'escapeParam' | 'prepareTyping'> {
	let encoder: unknown;
	return {
		prepareTyping: (next) => {
			encoder = next;
			return 'none';
		},
		escapeParam: (_num, value) => {
			const current = encoder;
			encoder = undefined;
			return placeholder(current, value);
		},
	};
}

// drizzle-orm/sql/sql.js: `SQL#toQuery()` renders through
// `this.buildQueryFromSourceParams(chunks, config)`, which calls itself on the
// same `this` for every nested SQL, array, subquery and SQLWrapper, so an
// override on the outermost SQL sees every chunk list of the statement.
// drizzle-orm/sql/expressions/conditions.js: `inArray(column, list)` and
// `notInArray()` are `sql\`${column} in ${list}\`` and `... not in ...`, the
// chunks `column, ' in ' | ' not in ', [elements]`, each element a `Param`
// or, for `sql.placeholder()`, the `Placeholder` itself. Checked against
// drizzle-orm 0.44.1 and 0.45.4.
/**
 * `statement`, rendering each `column in (a, b, …)` list of two or more
 * elements, one of them a `sql.placeholder()`, on a column for which
 * `expand(column)` is true as `(column = a or column = b …)`, and each
 * `column not in (…)` as `(column <> a and column <> b …)`.
 *
 * Both are the SQL definition of `IN` and `NOT IN`, nulls included. CUBRID
 * 11.4 types the host variables of an `IN` list as VARCHAR when none of its
 * elements is typed, and compares a CHAR column with them unpadded, so such
 * a list matched no row; each `= ?` compares padded (#239). src/dialect.ts
 * has a copy for the 0.x API, as for `escapeParamWithEncoder()`; change both.
 */
export function expandPlaceholderLists(statement: SQL, expand: (column: Column) => boolean): SQL {
	return new PlaceholderListsExpanded([statement], expand);
}

class PlaceholderListsExpanded extends SQL {
	constructor(
		chunks: SQLChunk[],
		private readonly expand: (column: Column) => boolean,
	) {
		super(chunks);
	}

	override buildQueryFromSourceParams(chunks: SQLChunk[], config: BuildQueryConfig): Query {
		let expanded: SQLChunk[] | undefined;
		for (let i = 0; i < chunks.length; i++) {
			const [column, keyword, list] = [chunks[i], chunks[i + 1], chunks[i + 2]];
			const text = is(keyword, StringChunk) ? keyword.value.join('') : undefined;
			const negate = text === ' not in ' ? true : text === ' in ' ? false : undefined;
			if (
				negate !== undefined &&
				is(column, Column) &&
				Array.isArray(list) &&
				list.length > 1 &&
				list.some((e) => is(e, Placeholder) || (is(e, Param) && is(e.value, Placeholder))) &&
				this.expand(column)
			) {
				expanded ??= chunks.slice(0, i);
				const terms = list.map((e) => (negate ? sql`${column} <> ${e}` : sql`${column} = ${e}`));
				expanded.push(sql`(${sql.join(terms, sql.raw(negate ? ' and ' : ' or '))})`);
				i += 2;
			} else {
				expanded?.push(chunks[i] as SQLChunk);
			}
		}
		return super.buildQueryFromSourceParams(expanded ?? chunks, config);
	}
}
