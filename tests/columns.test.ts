import * as columns from '../src/columns';
import { cubridTable } from '../src/table';

describe('columns exports', () => {
	it('exports key column builders', () => {
		expect(typeof columns.int).toBe('function');
		expect(typeof columns.varchar).toBe('function');
		expect(typeof columns.text).toBe('function');
		expect(typeof columns.datetime).toBe('function');
		expect(typeof columns.boolean).toBe('function');
		expect(typeof columns.timestamp).toBe('function');
		expect(typeof columns.cubridSet).toBe('function');
		expect(typeof columns.cubridMultiset).toBe('function');
		expect(typeof columns.cubridSequence).toBe('function');
	});

	it('refuses binary() and varbinary(), which do not round-trip on CUBRID (#216)', () => {
		expect(() => columns.binary('hash', { length: 4 })).toThrow(
			/^binary\(\) is not supported by drizzle-cubrid \(0\.x\): .*\(#216\)\. Use binary\(\) from drizzle-cubrid\/native, which reads and writes Buffer values/,
		);
		expect(() => columns.varbinary('data', { length: 8 })).toThrow(/varbinary\(\) from drizzle-cubrid\/native/);
		expect(() => columns.varbinary()).toThrow(/#216/);
	});

	it('does not export json builder', () => {
		expect('json' in columns).toBe(false);
		expect((columns as Record<string, unknown>).json).toBeUndefined();
	});

	it('column exports can be used with cubridTable', () => {
		const posts = cubridTable('posts', {
			id: columns.int('id').primaryKey().autoincrement(),
			title: columns.varchar('title', { length: 255 }),
			content: columns.text('content'),
			createdAt: columns.datetime('created_at'),
		});

		expect(posts.id.getSQLType()).toBe('int');
		expect(posts.title.getSQLType()).toBe('varchar(255)');
		expect(posts.content.getSQLType()).toBe('text');
		expect(posts.createdAt.getSQLType()).toBe('datetime');
	});
});
