// The removed 0.x exports of the root entry fail to compile when used, and the
// error names the replacement (ADR 0010).
import { describe, expectTypeOf, it } from 'vitest';
import { cubridSet, type RemovedFromRoot, serial, text } from '../../src/native/index';

describe('removed 0.x exports', () => {
	it('are not callable, and their type carries the message', () => {
		expectTypeOf(serial).not.toBeFunction();
		expectTypeOf(cubridSet).not.toBeFunction();
		expectTypeOf(text).toMatchTypeOf<RemovedFromRoot<string>>();
		// @ts-expect-error cubridSet() moved to drizzle-cubrid/legacy; use set({ element })
		cubridSet('tags');
		// @ts-expect-error text() moved to drizzle-cubrid/legacy; use string() or varchar({ length })
		text('body');
	});
});
