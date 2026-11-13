// Waits until a CUBRID broker answers a query, for the live CI job.
// Usage: CUBRID_TEST_HOST=127.0.0.1 node scripts/wait-for-cubrid.mjs [timeoutSeconds]
import { appendFileSync } from 'node:fs';
import { createClient } from 'cubrid-client';

const deadline = Date.now() + Number(process.argv[2] ?? 300) * 1000;
const config = {
	host: process.env.CUBRID_TEST_HOST ?? '127.0.0.1',
	port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
	database: process.env.CUBRID_TEST_DATABASE ?? 'testdb',
	user: process.env.CUBRID_TEST_USER ?? 'dba',
	password: process.env.CUBRID_TEST_PASSWORD ?? '',
	connectionTimeout: 5000,
};

for (let attempt = 1; ; attempt++) {
	const client = createClient(config);
	try {
		const [row] = await client.query('SELECT version() AS v');
		console.log(`CUBRID ready after ${attempt} attempt(s): ${row.v}`);
		if (process.env.GITHUB_STEP_SUMMARY) {
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CUBRID server version: ${row.v}\n`);
		}
		await client.close();
		process.exit(0);
	} catch (error) {
		await client.close().catch(() => undefined);
		if (Date.now() > deadline) {
			console.error(`CUBRID not ready: ${error instanceof Error ? error.message : error}`);
			process.exit(1);
		}
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}
}
