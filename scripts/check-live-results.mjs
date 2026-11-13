// Fails the live CI job unless tests actually ran and none were skipped.
// Usage: node scripts/check-live-results.mjs <vitest json report>
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { numTotalTests, numPassedTests, numFailedTests, numPendingTests, numTodoTests } = report;
console.log(
	`Live CUBRID tests: ${numTotalTests} total, ${numPassedTests} passed, ${numFailedTests} failed, ${numPendingTests} skipped, ${numTodoTests} todo`,
);
if (!(numTotalTests > 0) || numPassedTests !== numTotalTests || numPendingTests > 0 || numTodoTests > 0) {
	console.error('::error::The live CUBRID gate needs every test to run and pass, with none skipped');
	process.exit(1);
}
