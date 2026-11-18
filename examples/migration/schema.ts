// The schema the example migrations create (drizzle-cubrid/native).
import { cubridTable, integer, varchar } from 'drizzle-cubrid/native';

export const users = cubridTable('users', {
	id: integer().primaryKey().autoIncrement(),
	name: varchar({ length: 50 }).notNull(),
	// Added by migrations/0002_add_email.sql.
	email: varchar({ length: 100 }),
});
