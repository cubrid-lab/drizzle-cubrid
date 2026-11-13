// Fails the live CI job unless tests actually ran and none were skipped.
// Usage: node scripts/check-live-results.mjs <vitest json report>
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

if (!existsSync(process.argv[2])) {
	fail(`No live test report at ${process.argv[2]}; the test run did not finish`);
}
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { numTotalTests, numPassedTests, numFailedTests, numPendingTests, numTodoTests } = report;
const line = `Live CUBRID tests: ${numTotalTests} total, ${numPassedTests} passed, ${numFailedTests} failed, ${numPendingTests} skipped, ${numTodoTests} todo`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}
if (!(numTotalTests > 0) || numPassedTests !== numTotalTests || numPendingTests > 0 || numTodoTests > 0) {
	fail('The live CUBRID gate needs every test to run and pass, with none skipped');
}
