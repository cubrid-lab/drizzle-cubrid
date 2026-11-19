// Foreign keys of native tables (#157): `foreignKey()` in `cubridTable()`'s
// third argument and a column's `.references()`. Kept apart from table.ts so
// the column builders can create them without a runtime import cycle.

import { entityKind } from 'drizzle-orm/entity';
import type { CubridColumn } from './columns/common.js';

/**
 * The referential actions CUBRID 11.4 accepts for `ON DELETE`. `SET DEFAULT`
 * is not CUBRID syntax (-493).
 */
export type CubridForeignKeyAction = 'cascade' | 'restrict' | 'no action' | 'set null';

/**
 * The referential actions CUBRID 11.4 accepts for `ON UPDATE`: `CASCADE` is
 * refused by the server (-493), as is `SET DEFAULT`.
 */
export type CubridForeignKeyUpdateAction = 'restrict' | 'no action' | 'set null';

const DELETE_ACTIONS: readonly string[] = ['cascade', 'restrict', 'no action', 'set null'];
const UPDATE_ACTIONS: readonly string[] = ['restrict', 'no action', 'set null'];

export interface CubridForeignKeyActions {
	onDelete?: CubridForeignKeyAction;
	onUpdate?: CubridForeignKeyUpdateAction;
}

/** The columns of a foreign key and the columns they reference. */
export interface CubridForeignKeyReference {
	columns: readonly CubridColumn[];
	foreignColumns: readonly CubridColumn[];
}

function checkedAction(action: string, allowed: readonly string[], clause: string): string {
	if (!allowed.includes(action)) {
		throw new TypeError(
			`${clause} ${JSON.stringify(action)} is not supported by CUBRID; use one of ${allowed.map((a) => `'${a}'`).join(', ')}`,
		);
	}
	return action;
}

/** A table `FOREIGN KEY` constraint: {@link foreignKey} or a column's `.references()`. */
export class CubridForeignKey {
	static readonly [entityKind]: string = 'CubridForeignKey';

	private deleteAction: CubridForeignKeyAction | undefined;
	private updateAction: CubridForeignKeyUpdateAction | undefined;

	constructor(
		private readonly reference: () => CubridForeignKeyReference,
		readonly name: string | undefined,
		actions: CubridForeignKeyActions = {},
	) {
		if (actions.onDelete !== undefined) this.onDelete(actions.onDelete);
		if (actions.onUpdate !== undefined) this.onUpdate(actions.onUpdate);
	}

	/** `ON DELETE`; CUBRID's default is `RESTRICT`. */
	onDelete(action: CubridForeignKeyAction): this {
		this.deleteAction = checkedAction(action, DELETE_ACTIONS, 'ON DELETE') as CubridForeignKeyAction;
		return this;
	}

	/** `ON UPDATE`; CUBRID's default is `RESTRICT`, and it has no `ON UPDATE CASCADE`. */
	onUpdate(action: CubridForeignKeyUpdateAction): this {
		this.updateAction = checkedAction(action, UPDATE_ACTIONS, 'ON UPDATE') as CubridForeignKeyUpdateAction;
		return this;
	}

	get onDeleteAction(): CubridForeignKeyAction | undefined {
		return this.deleteAction;
	}

	get onUpdateAction(): CubridForeignKeyUpdateAction | undefined {
		return this.updateAction;
	}

	/** The columns and the referenced columns, resolved now (a `.references()` callback runs here). */
	getReference(): CubridForeignKeyReference {
		const { columns, foreignColumns } = this.reference();
		return { columns: [...columns], foreignColumns: [...foreignColumns] };
	}
}

/**
 * `FOREIGN KEY (a, b) REFERENCES other (x, y)`:
 * `foreignKey({ name?, columns: [t.a, t.b], foreignColumns: [other.x, other.y] })`,
 * then `.onDelete()` / `.onUpdate()`. Without a name, CUBRID names it.
 */
export function foreignKey(config: {
	name?: string;
	columns: readonly [CubridColumn, ...CubridColumn[]];
	foreignColumns: readonly [CubridColumn, ...CubridColumn[]];
}): CubridForeignKey {
	const reference = { columns: [...config.columns], foreignColumns: [...config.foreignColumns] };
	return new CubridForeignKey(() => reference, config.name);
}
