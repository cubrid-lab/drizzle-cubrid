// The few Node.js built-ins drizzle-cubrid/native/migrator uses (#163), typed
// here because the repository has no @types/node: adding it changes how
// cubrid-client's own declarations resolve for the 0.x code. Node 18 has all
// of them. Nothing in the published declarations refers to these modules.

declare module 'node:crypto' {
	interface Hash {
		update(data: string, encoding: 'utf8'): Hash;
		digest(encoding: 'hex'): string;
	}
	export function createHash(algorithm: 'sha256'): Hash;
}

declare module 'node:fs/promises' {
	interface DirectoryEntry {
		name: string;
		isFile(): boolean;
		isDirectory(): boolean;
	}
	export function readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>;
	export function readdir(path: string): Promise<string[]>;
	export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}

declare module 'node:path' {
	export function join(...paths: string[]): string;
}
