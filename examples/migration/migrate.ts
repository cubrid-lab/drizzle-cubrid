// Applies ./migrations to the database named by the CUBRID_* environment variables.
// Run it with a TypeScript runner, for example: npx tsx examples/migration/migrate.ts
import { fileURLToPath } from 'node:url';
import { createClient } from 'cubrid-client';
import { drizzle } from 'drizzle-cubrid';
import { migrate } from 'drizzle-cubrid/migrator';

const client = createClient({
	host: process.env.CUBRID_HOST ?? '127.0.0.1',
	port: Number(process.env.CUBRID_PORT ?? 33000),
	database: process.env.CUBRID_DATABASE ?? 'demodb',
	user: process.env.CUBRID_USER ?? 'dba',
	password: process.env.CUBRID_PASSWORD ?? '',
});

try {
	const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
	const plan = await migrate(drizzle(client), { migrationsFolder, dryRun: true });
	console.log(`pending: ${plan.pending.map((m) => m.fileName).join(', ') || 'none'}`);
	const { applied } = await migrate(drizzle(client), { migrationsFolder });
	console.log(`applied: ${applied.map((m) => m.fileName).join(', ') || 'none'}`);
} finally {
	await client.close();
}
