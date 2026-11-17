// The schema of the native relational query tests (#158): one-to-many,
// many-to-one, one-to-one, a self relation, many-to-many through a junction
// table and a composite key.
import { relations } from 'drizzle-orm';

import { bigint, cubridTable, datetime, integer, primaryKey, set, varchar } from '../../src/native/index';

export const users = cubridTable('users', {
	id: bigint({ mode: 'bigint' }).primaryKey(),
	name: varchar({ length: 50 }).notNull(),
	managerId: bigint('manager_id', { mode: 'bigint' }),
});
export const posts = cubridTable('posts', {
	id: integer().primaryKey(),
	authorId: bigint('author_id', { mode: 'bigint' }).notNull(),
	title: varchar({ length: 50 }).notNull(),
	at: datetime(),
	tags: set({ element: varchar({ length: 10 }) }),
});
export const comments = cubridTable('comments', {
	id: integer().primaryKey(),
	postId: integer('post_id').notNull(),
	body: varchar({ length: 50 }).notNull(),
});
export const profiles = cubridTable('profiles', {
	userId: bigint('user_id', { mode: 'bigint' }).primaryKey(),
	bio: varchar({ length: 50 }),
});
export const groups = cubridTable('groups', {
	id: integer().primaryKey(),
	name: varchar({ length: 50 }).notNull(),
});
export const memberships = cubridTable(
	'memberships',
	{ userId: bigint('user_id', { mode: 'bigint' }).notNull(), groupId: integer('group_id').notNull() },
	(t) => [primaryKey({ columns: [t.userId, t.groupId] })],
);
export const orders = cubridTable(
	'orders',
	{ region: varchar({ length: 10 }).notNull(), num: integer().notNull(), note: varchar({ length: 50 }) },
	(t) => [primaryKey({ columns: [t.region, t.num] })],
);
export const lines = cubridTable('lines', {
	id: integer().primaryKey(),
	region: varchar({ length: 10 }).notNull(),
	num: integer().notNull(),
	qty: integer().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
	posts: many(posts),
	profile: one(profiles),
	manager: one(users, { fields: [users.managerId], references: [users.id], relationName: 'manager' }),
	reports: many(users, { relationName: 'manager' }),
	memberships: many(memberships),
}));
export const postsRelations = relations(posts, ({ one, many }) => ({
	author: one(users, { fields: [posts.authorId], references: [users.id] }),
	comments: many(comments),
}));
export const commentsRelations = relations(comments, ({ one }) => ({
	post: one(posts, { fields: [comments.postId], references: [posts.id] }),
}));
export const profilesRelations = relations(profiles, ({ one }) => ({
	user: one(users, { fields: [profiles.userId], references: [users.id] }),
}));
export const groupsRelations = relations(groups, ({ many }) => ({ memberships: many(memberships) }));
export const membershipsRelations = relations(memberships, ({ one }) => ({
	user: one(users, { fields: [memberships.userId], references: [users.id] }),
	group: one(groups, { fields: [memberships.groupId], references: [groups.id] }),
}));
export const ordersRelations = relations(orders, ({ many }) => ({ lines: many(lines) }));
export const linesRelations = relations(lines, ({ one }) => ({
	order: one(orders, { fields: [lines.region, lines.num], references: [orders.region, orders.num] }),
}));
