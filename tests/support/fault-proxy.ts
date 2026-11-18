// A TCP proxy between the client and a CUBRID broker that the fault tests
// (tests/faults.test.ts) use to cut, stall or refuse connections at a chosen
// moment without touching the server.
//
// It relies on the broker handing the client's socket to a CAS process (the
// broker answers the client info exchange with port 0), so every byte of a
// session passes through the proxy. `opened` counts accepted connections, and
// a client that was redirected to another port would bypass the proxy: the
// tests check that their faults actually fired.
import { createConnection, createServer, type Server, type Socket } from 'node:net';

interface Link {
	client: Socket;
	server: Socket;
	/** Bytes held back while the proxy is stalled, per direction. */
	held: { toServer: Buffer[]; toClient: Buffer[] };
	/** Set once this link forwarded a request that must not get its reply. */
	cutOnReply?: () => void;
}

/** What `failNextRequest()` does with the request it matches. */
export type RequestFault =
	/** Cut the connection instead of forwarding the request: the server never sees it. */
	| 'before-server'
	/** Forward the request, then cut the connection instead of forwarding its reply. */
	| 'after-server';

/** CAS function codes, the first payload byte of a request. */
export const CAS_FUNCTION = { END_TRAN: 1, PREPARE: 2, EXECUTE: 3, CHECK_CAS: 32, PREPARE_AND_EXECUTE: 41 } as const;

/** The payload of a CAS request: its function code, then its arguments. */
export type RequestMatcher = (payload: Buffer) => boolean;

/** END_TRAN with COMMIT: function code 1, then the one-byte argument 1 (length 1, value 1). */
export const isCommit: RequestMatcher = (payload) =>
	payload.length === 6 && payload[0] === CAS_FUNCTION.END_TRAN && payload.readInt32BE(1) === 1 && payload[5] === 1;

/**
 * The offset of the first request in `chunk` that `match` accepts, or -1.
 * A request is a 4-byte payload length, 4 bytes of CAS info and the payload.
 * The client writes each request with one write, so a chunk starts at a
 * request boundary; a chunk that does not parse as whole requests matches
 * nothing (the test then waits for a fault that never fires and times out).
 */
function findRequest(chunk: Buffer, match: RequestMatcher): number {
	let offset = 0;
	while (offset + 8 <= chunk.length) {
		const length = chunk.readInt32BE(offset);
		const end = offset + 8 + length;
		if (length < 1 || end > chunk.length) return -1;
		if (match(chunk.subarray(offset + 8, end))) return offset;
		offset = end;
	}
	return -1;
}

export class FaultProxy {
	private readonly links = new Set<Link>();
	private stalled = false;
	private refusing = false;
	private requestFault: { match: RequestMatcher; mode: RequestFault; fired: () => void } | undefined;
	/** Connections the proxy accepted, refused ones included. */
	opened = 0;

	private constructor(
		private readonly server: Server,
		readonly port: number,
		private readonly target: { host: string; port: number },
	) {
		server.on('connection', (client) => this.accept(client));
	}

	static async start(target: { host: string; port: number }): Promise<FaultProxy> {
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('The fault proxy has no TCP port');
		return new FaultProxy(server, address.port, target);
	}

	/** Connections currently open through the proxy. */
	get active(): number {
		return this.links.size;
	}

	private accept(client: Socket): void {
		this.opened++;
		if (this.refusing) {
			client.destroy();
			return;
		}
		const server = createConnection(this.target);
		const link: Link = { client, server, held: { toServer: [], toClient: [] } };
		this.links.add(link);
		client.setNoDelay(true);
		server.setNoDelay(true);
		const drop = () => this.drop(link);
		client.on('error', drop).on('close', drop);
		server.on('error', drop).on('close', drop);
		client.on('data', (chunk: Buffer) => this.toServer(link, chunk));
		server.on('data', (chunk: Buffer) => this.toClient(link, chunk));
	}

	private toServer(link: Link, chunk: Buffer): void {
		if (this.stalled) {
			link.held.toServer.push(chunk);
			return;
		}
		const fault = this.requestFault;
		const at = fault ? findRequest(chunk, fault.match) : -1;
		if (fault && at >= 0) {
			this.requestFault = undefined;
			if (fault.mode === 'before-server') {
				// Forward the requests before the matched one, never that one.
				if (at > 0) link.server.write(chunk.subarray(0, at));
				this.drop(link);
				fault.fired();
				return;
			}
			link.cutOnReply = fault.fired;
		}
		link.server.write(chunk);
	}

	private toClient(link: Link, chunk: Buffer): void {
		if (link.cutOnReply) {
			// The server answered the request; the client never gets the answer.
			const fired = link.cutOnReply;
			link.cutOnReply = undefined;
			this.drop(link);
			fired();
			return;
		}
		if (this.stalled) {
			link.held.toClient.push(chunk);
			return;
		}
		link.client.write(chunk);
	}

	private drop(link: Link): void {
		if (!this.links.delete(link)) return;
		// A reset, as a dead peer or a middlebox dropping the flow would produce.
		link.client.resetAndDestroy();
		link.server.destroy();
	}

	/** Closes every open connection, in both directions. */
	cutAll(): number {
		const count = this.links.size;
		for (const link of [...this.links]) this.drop(link);
		return count;
	}

	/** Holds back every byte in both directions, as a stalled network would, until `resume()`. */
	stall(): void {
		this.stalled = true;
	}

	/** Delivers what `stall()` held back and forwards again. */
	resume(): void {
		this.stalled = false;
		for (const link of this.links) {
			const { toServer, toClient } = link.held;
			link.held = { toServer: [], toClient: [] };
			for (const chunk of toServer) this.toServer(link, chunk);
			for (const chunk of toClient) this.toClient(link, chunk);
		}
	}

	/** While on, closes every new connection at once, as a server that is down would. */
	refuse(on: boolean): void {
		this.refusing = on;
	}

	/**
	 * Fails the next request that `match` accepts, on whichever connection
	 * sends it, as `mode` says. The returned promise resolves once it fired.
	 */
	failNextRequest(match: RequestMatcher, mode: RequestFault): Promise<void> {
		return new Promise((resolve) => {
			this.requestFault = { match, mode, fired: resolve };
		});
	}

	async close(): Promise<void> {
		this.requestFault = undefined;
		this.cutAll();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}
