import { int, varchar } from '../src/columns';
import { cubridMultiset, cubridSequence, cubridSet } from '../src/columns/collections';
import { cubridTable } from '../src/table';
import { monetary, multiset, sequence, set } from '../src/types';

describe('collection and monetary types', () => {
	it('cubridSet dataType SQL is generated correctly', () => {
		const table = cubridTable('set_types', {
			tags: cubridSet('tags', { element: varchar('tag_item', { length: 100 }) }),
			numbers: cubridSet('numbers', { element: int('set_item') }),
		});

		expect(table.tags.getSQLType()).toBe('SET(VARCHAR(100))');
		expect(table.numbers.getSQLType()).toBe('SET(INTEGER)');
	});

	it('cubridMultiset dataType SQL is generated correctly', () => {
		const table = cubridTable('multiset_types', {
			tags: cubridMultiset('tags', { element: int('multi_item') }),
		});

		expect(table.tags.getSQLType()).toBe('MULTISET(INTEGER)');
	});

	it('cubridSequence dataType SQL is generated correctly', () => {
		const table = cubridTable('sequence_types', {
			values: cubridSequence('values', { element: varchar('sequence_item', { length: 200 }) }),
		});

		expect(table.values.getSQLType()).toBe('SEQUENCE(VARCHAR(200))');
	});

	it('collection builders use default element type when not provided', () => {
		const table = cubridTable('default_collection_types', {
			tags: cubridSet('tags'),
		});

		expect(table.tags.getSQLType()).toBe('SET(VARCHAR(100))');
	});

	it('collection aliases keep backward compatibility', () => {
		const table = cubridTable('alias_types', {
			a: set('a', { element: varchar('v', { length: 30 }) }),
			b: multiset('b', { element: int('n') }),
			c: sequence('c', { element: varchar('s', { length: 40 }) }),
		});

		expect(table.a.getSQLType()).toBe('SET(VARCHAR(30))');
		expect(table.b.getSQLType()).toBe('MULTISET(INTEGER)');
		expect(table.c.getSQLType()).toBe('SEQUENCE(VARCHAR(40))');
	});

	it('monetary dataType returns MONETARY', () => {
		const table = cubridTable('money_types', {
			price: monetary('price'),
		});

		expect(table.price.getSQLType()).toBe('MONETARY');
	});

	it('monetary reads the driver number as the declared string (#217)', () => {
		const price = cubridTable('money_read', { price: monetary('price') }).price;

		expect(price.mapFromDriverValue(12.34)).toBe('12.34');
		expect(price.mapFromDriverValue(-0.5)).toBe('-0.5');
		expect(price.mapFromDriverValue(1e21)).toBe('1e+21');
		expect(price.mapFromDriverValue('7.25')).toBe('7.25');
		expect(price.mapToDriverValue('12.34')).toBe('12.34');
	});

	it('collection works in a normal table definition', () => {
		const table = cubridTable('mixed_types', {
			id: int('id').primaryKey().autoincrement(),
			name: varchar('name', { length: 100 }),
			tags: cubridSet('tags', { element: varchar('tag_item', { length: 32 }) }),
		});

		expect(table.id.getSQLType()).toBe('int');
		expect(table.name.getSQLType()).toBe('varchar(100)');
		expect(table.tags.getSQLType()).toBe('SET(VARCHAR(32))');
	});
});
