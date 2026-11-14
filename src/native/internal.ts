// The only place native code touches Drizzle internals (ADR 0007, decision 2).
//
// Every accessor below names the drizzle-orm file it depends on and the
// versions it was checked against. Outside this file, native code may not use
// `Symbol.for('drizzle:…')`, `.decoder`, `.shouldDisableInsert`, `setName` or
// any cast through `unknown`, `any` or `never`; scripts/check-dialect-boundary.mjs
// enforces that.

import type { Column } from 'drizzle-orm/column';
import type { DriverValueDecoder, SQL } from 'drizzle-orm/sql/sql';
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
