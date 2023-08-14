// noinspection TypeScriptValidateJSTypes

import assert from "assert";
import fs from "fs/promises";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { Writable } from "stream";
import util from "util";
import {
	D1Database,
	DurableObjectNamespace,
	Fetcher,
	KVNamespace,
	Queue,
	R2Bucket,
} from "@cloudflare/workers-types/experimental";
import test, { ThrowsExpectation } from "ava";
import {
	DeferredPromise,
	MessageEvent,
	Miniflare,
	MiniflareCoreError,
	MiniflareOptions,
	ReplaceWorkersTypes,
	Response,
	_transformsForContentEncoding,
	createFetchMock,
	fetch,
	viewToBuffer,
} from "miniflare";
import {
	CloseEvent as StandardCloseEvent,
	MessageEvent as StandardMessageEvent,
	WebSocketServer,
} from "ws";
import { TestLog, useServer, useTmp, utf8Encode } from "./test-shared";

test("Miniflare: validates options", async (t) => {
	// Check empty workers array rejected
	t.throws(() => new Miniflare({ workers: [] }), {
		instanceOf: MiniflareCoreError,
		code: "ERR_NO_WORKERS",
		message: "No workers defined",
	});

	// Check workers with the same name rejected
	t.throws(
		() =>
			new Miniflare({
				workers: [{ script: "" }, { script: "" }],
			}),
		{
			instanceOf: MiniflareCoreError,
			code: "ERR_DUPLICATE_NAME",
			message: "Multiple workers defined without a `name`",
		}
	);
	t.throws(
		() =>
			new Miniflare({
				workers: [
					{ script: "" },
					{ script: "", name: "a" },
					{ script: "", name: "b" },
					{ script: "", name: "a" },
				],
			}),
		{
			instanceOf: MiniflareCoreError,
			code: "ERR_DUPLICATE_NAME",
			message: 'Multiple workers defined with the same `name`: "a"',
		}
	);
});

test("Miniflare: ready returns copy of entry URL", async (t) => {
	const mf = new Miniflare({
		port: 0,
		modules: true,
		script: "",
	});
	t.teardown(() => mf.dispose());

	const url1 = await mf.ready;
	url1.protocol = "ws:";
	const url2 = await mf.ready;
	t.not(url1, url2);
	t.is(url2.protocol, "http:");
});

test("Miniflare: keeps port between updates", async (t) => {
	const opts: MiniflareOptions = {
		port: 0,
		script: `addEventListener("fetch", (event) => {
      event.respondWith(new Response("a"));
    })`,
	};
	const mf = new Miniflare(opts);
	t.teardown(() => mf.dispose());
	const initialURL = await mf.ready;

	await mf.setOptions(opts);
	const updatedURL = await mf.ready;

	t.not(initialURL.port, "0");
	t.is(initialURL.port, updatedURL.port);
});

test("Miniflare: routes to multiple workers with fallback", async (t) => {
	const opts: MiniflareOptions = {
		workers: [
			{
				name: "a",
				routes: ["*/api"],
				script: `addEventListener("fetch", (event) => {
          event.respondWith(new Response("a"));
        })`,
			},
			{
				name: "b",
				routes: ["*/api/*"], // Less specific than "a"'s
				script: `addEventListener("fetch", (event) => {
          event.respondWith(new Response("b"));
        })`,
			},
		],
	};
	const mf = new Miniflare(opts);
	t.teardown(() => mf.dispose());

	// Check "a"'s more specific route checked first
	let res = await mf.dispatchFetch("http://localhost/api");
	t.is(await res.text(), "a");

	// Check "b" still accessible
	res = await mf.dispatchFetch("http://localhost/api/2");
	t.is(await res.text(), "b");

	// Check fallback to first
	res = await mf.dispatchFetch("http://localhost/notapi");
	t.is(await res.text(), "a");
});

test("Miniflare: custom service using Content-Encoding header", async (t) => {
	const testBody = "x".repeat(100);
	const { http } = await useServer(t, (req, res) => {
		const testEncoding = req.headers["x-test-encoding"]?.toString();
		const encoders = _transformsForContentEncoding(testEncoding);
		let initialStream: Writable = res;
		for (let i = encoders.length - 1; i >= 0; i--) {
			encoders[i].pipe(initialStream);
			initialStream = encoders[i];
		}
		res.writeHead(200, { "Content-Encoding": testEncoding });
		initialStream.write(testBody);
		initialStream.end();
	});
	const mf = new Miniflare({
		script: `addEventListener("fetch", (event) => {
      event.respondWith(CUSTOM.fetch(event.request));
    })`,
		serviceBindings: {
			CUSTOM(request) {
				return fetch(http, request);
			},
		},
	});
	t.teardown(() => mf.dispose());

	const test = async (encoding: string) => {
		const res = await mf.dispatchFetch("http://localhost", {
			headers: { "X-Test-Encoding": encoding },
		});
		t.is(res.headers.get("Content-Encoding"), encoding);
		t.is(await res.text(), testBody, encoding);
	};

	await test("gzip");
	await test("deflate");
	await test("br");
	// `undici`'s `fetch()` is currently broken when `Content-Encoding` specifies
	// multiple encodings. Once https://github.com/nodejs/undici/pull/2159 is
	// released, we can re-enable this test.
	// TODO(soon): re-enable this test
	// await test("deflate, gzip");
});

test("Miniflare: custom service using Set-Cookie header", async (t) => {
	const testCookies = [
		"key1=value1; Max-Age=3600",
		"key2=value2; Domain=example.com; Secure",
	];
	const { http } = await useServer(t, (req, res) => {
		res.writeHead(200, { "Set-Cookie": testCookies });
		res.end();
	});
	const mf = new Miniflare({
		modules: true,
		script: `export default {
      async fetch(request, env, ctx) {
        const res = await env.CUSTOM.fetch(request);
        return Response.json(res.headers.getSetCookie());
      }
    }`,
		serviceBindings: {
			CUSTOM(request) {
				return fetch(http, request);
			},
		},
		// Enable `Headers#getSetCookie()`:
		// https://github.com/cloudflare/workerd/blob/14b54764609c263ea36ab862bb8bf512f9b1387b/src/workerd/io/compatibility-date.capnp#L273-L278
		compatibilityDate: "2023-03-01",
	});
	t.teardown(() => mf.dispose());

	const res = await mf.dispatchFetch("http://localhost");
	t.deepEqual(await res.json(), testCookies);
});

test("Miniflare: web socket kitchen sink", async (t) => {
	// Create deferred promises for asserting asynchronous event results
	const clientEventPromise = new DeferredPromise<MessageEvent>();
	const serverMessageEventPromise = new DeferredPromise<StandardMessageEvent>();
	const serverCloseEventPromise = new DeferredPromise<StandardCloseEvent>();

	// Create WebSocket origin server
	const server = http.createServer();
	const wss = new WebSocketServer({
		server,
		handleProtocols(protocols) {
			t.deepEqual(protocols, new Set(["protocol1", "protocol2"]));
			return "protocol2";
		},
	});
	wss.on("connection", (ws, req) => {
		// Testing receiving additional headers sent from upgrade request
		t.is(req.headers["user-agent"], "Test");

		ws.send("hello from server");
		ws.addEventListener("message", serverMessageEventPromise.resolve);
		ws.addEventListener("close", serverCloseEventPromise.resolve);
	});
	wss.on("headers", (headers) => {
		headers.push("Set-Cookie: key=value");
	});
	const port = await new Promise<number>((resolve) => {
		server.listen(0, () => {
			t.teardown(() => server.close());
			resolve((server.address() as AddressInfo).port);
		});
	});

	// Create Miniflare instance with WebSocket worker and custom service binding
	// fetching from WebSocket origin server
	const mf = new Miniflare({
		script: `addEventListener("fetch", (event) => {
      event.respondWith(CUSTOM.fetch(event.request));
    })`,
		serviceBindings: {
			// Testing loopback server WebSocket coupling
			CUSTOM(request) {
				// Testing dispatchFetch custom cf injection
				t.is(request.cf?.country, "MF");
				// Testing dispatchFetch injects default cf values
				t.is(request.cf?.regionCode, "TX");
				t.is(request.headers.get("MF-Custom-Service"), null);
				// Testing WebSocket-upgrading fetch
				return fetch(`http://localhost:${port}`, request);
			},
		},
	});
	t.teardown(() => mf.dispose());

	// Testing dispatchFetch WebSocket coupling
	const res = await mf.dispatchFetch("http://localhost", {
		headers: {
			Upgrade: "websocket",
			"User-Agent": "Test",
			"Sec-WebSocket-Protocol": "protocol1, protocol2",
		},
		cf: { country: "MF" },
	});

	assert(res.webSocket);
	res.webSocket.addEventListener("message", clientEventPromise.resolve);
	res.webSocket.accept();
	res.webSocket.send("hello from client");
	res.webSocket.close(1000, "Test Closure");
	// Test receiving additional headers from upgrade response
	t.is(res.headers.get("Set-Cookie"), "key=value");
	t.is(res.headers.get("Sec-WebSocket-Protocol"), "protocol2");

	// Check event results
	const clientEvent = await clientEventPromise;
	const serverMessageEvent = await serverMessageEventPromise;
	const serverCloseEvent = await serverCloseEventPromise;
	t.is(clientEvent.data, "hello from server");
	t.is(serverMessageEvent.data, "hello from client");
	t.is(serverCloseEvent.code, 1000);
	t.is(serverCloseEvent.reason, "Test Closure");
});

test("Miniflare: custom service binding to another Miniflare instance", async (t) => {
	const mfOther = new Miniflare({
		modules: true,
		script: `export default {
      async fetch(request) {
        const { method, url } = request;
        const body = request.body && await request.text();
        return Response.json({ method, url, body });
      }
    }`,
	});
	t.teardown(() => mfOther.dispose());

	const mf = new Miniflare({
		script: `addEventListener("fetch", (event) => {
      event.respondWith(CUSTOM.fetch(event.request));
    })`,
		serviceBindings: {
			async CUSTOM(request) {
				// Check internal keys removed (e.g. `MF-Custom-Service`, `MF-Original-URL`)
				// https://github.com/cloudflare/miniflare/issues/475
				const keys = [...request.headers.keys()];
				t.deepEqual(
					keys.filter((key) => key.toLowerCase().startsWith("mf-")),
					[]
				);

				return await mfOther.dispatchFetch(request);
			},
		},
	});
	t.teardown(() => mf.dispose());

	// Checking URL (including protocol/host) and body preserved through
	// `dispatchFetch()` and custom service bindings
	let res = await mf.dispatchFetch("https://custom1.mf/a");
	t.deepEqual(await res.json(), {
		method: "GET",
		url: "https://custom1.mf/a",
		body: null,
	});

	res = await mf.dispatchFetch("https://custom2.mf/b", {
		method: "POST",
		body: "body",
	});
	t.deepEqual(await res.json(), {
		method: "POST",
		url: "https://custom2.mf/b",
		body: "body",
	});

	// https://github.com/cloudflare/miniflare/issues/476
	res = await mf.dispatchFetch("https://custom3.mf/c", { method: "DELETE" });
	t.deepEqual(await res.json(), {
		method: "DELETE",
		url: "https://custom3.mf/c",
		body: null,
	});
});

test("Miniflare: custom outbound service", async (t) => {
	const mf = new Miniflare({
		workers: [
			{
				name: "a",
				modules: true,
				script: `export default {
          async fetch() {
            const res1 = await (await fetch("https://example.com/1")).text();
            const res2 = await (await fetch("https://example.com/2")).text();
            return Response.json({ res1, res2 });
          }
        }`,
				outboundService: "b",
			},
			{
				name: "b",
				modules: true,
				script: `export default {
          async fetch(request, env) {
            if (request.url === "https://example.com/1") {
              return new Response("one");
            } else {
              return fetch(request);
            }
          }
        }`,
				outboundService(request) {
					return new Response(`fallback:${request.url}`);
				},
			},
		],
	});
	t.teardown(() => mf.dispose());
	const res = await mf.dispatchFetch("http://localhost");
	t.deepEqual(await res.json(), {
		res1: "one",
		res2: "fallback:https://example.com/2",
	});
});

test("Miniflare: fetch mocking", async (t) => {
	const fetchMock = createFetchMock();
	fetchMock.disableNetConnect();
	const origin = fetchMock.get("https://example.com");
	origin.intercept({ method: "GET", path: "/" }).reply(200, "Mocked response!");

	const mf = new Miniflare({
		modules: true,
		script: `export default {
      async fetch() {
        return fetch("https://example.com/");
      }
    }`,
		fetchMock,
	});
	t.teardown(() => mf.dispose());
	const res = await mf.dispatchFetch("http://localhost");
	t.is(await res.text(), "Mocked response!");

	// Check `outboundService`and `fetchMock` mutually exclusive
	await t.throwsAsync(
		mf.setOptions({
			script: "",
			fetchMock,
			outboundService: "",
		}),
		{
			instanceOf: MiniflareCoreError,
			code: "ERR_MULTIPLE_OUTBOUNDS",
			message:
				"Only one of `outboundService` or `fetchMock` may be specified per worker",
		}
	);
});

test("Miniflare: custom upstream as origin", async (t) => {
	const upstream = await useServer(t, (req, res) => {
		res.end(`upstream: ${new URL(req.url ?? "", "http://upstream")}`);
	});
	const mf = new Miniflare({
		upstream: new URL("/extra/", upstream.http.toString()).toString(),
		modules: true,
		script: `export default {
      fetch(request) {
        return fetch(request);
      }
    }`,
	});
	t.teardown(() => mf.dispose());
	// Check rewrites protocol, hostname, and port, but keeps pathname and query
	const res = await mf.dispatchFetch("https://random:0/path?a=1");
	t.is(await res.text(), "upstream: http://upstream/extra/path?a=1");
});

test("Miniflare: `node:`, `cloudflare:` and `workerd:` modules", async (t) => {
	const mf = new Miniflare({
		modules: true,
		compatibilityFlags: ["nodejs_compat", "rtti_api"],
		scriptPath: "index.mjs",
		script: `
    import assert from "node:assert";
    import { Buffer } from "node:buffer";
    import { connect } from "cloudflare:sockets"; 
    import rtti from "workerd:rtti";
    export default {
      fetch() {
        assert.strictEqual(typeof connect, "function");
        assert.strictEqual(typeof rtti, "object");
        return new Response(Buffer.from("test").toString("base64"))
      }
    }
    `,
	});
	t.teardown(() => mf.dispose());
	const res = await mf.dispatchFetch("http://localhost");
	t.is(await res.text(), "dGVzdA==");
});

test("Miniflare: modules in sub-directories", async (t) => {
	const mf = new Miniflare({
		modules: [
			{
				type: "ESModule",
				path: "index.js",
				contents: `import { b } from "./sub1/index.js"; export default { fetch() { return new Response(String(b + 3)); } }`,
			},
			{
				type: "ESModule",
				path: "sub1/index.js",
				contents: `import { c } from "./sub2/index.js"; export const b = c + 20;`,
			},
			{
				type: "ESModule",
				path: "sub1/sub2/index.js",
				contents: `export const c = 100;`,
			},
		],
	});
	t.teardown(() => mf.dispose());
	const res = await mf.dispatchFetch("http://localhost");
	t.is(await res.text(), "123");
});

test("Miniflare: HTTPS fetches using browser CA certificates", async (t) => {
	const mf = new Miniflare({
		modules: true,
		script: `export default {
      fetch() {
        return fetch("https://workers.cloudflare.com/cf.json");
      }
    }`,
	});
	t.teardown(() => mf.dispose());
	const res = await mf.dispatchFetch("http://localhost");
	t.true(res.ok);
	await res.arrayBuffer(); // (drain)
});

test("Miniflare: accepts https requests", async (t) => {
	const log = new TestLog(t);

	const mf = new Miniflare({
		log,
		modules: true,
		https: true,
		script: `export default {
      fetch() {
        return new Response("Hello world");
      }
    }`,
	});
	t.teardown(() => mf.dispose());

	const res = await mf.dispatchFetch("https://localhost");
	t.true(res.ok);
	await res.arrayBuffer(); // (drain)

	t.assert(log.logs[0][1].startsWith("Ready on https://"));
});

test("Miniflare: manually triggered scheduled events", async (t) => {
	const log = new TestLog(t);

	const mf = new Miniflare({
		log,
		modules: true,
		script: `
    let scheduledRun = false;
    export default {
      fetch() {
        return new Response(scheduledRun);
      },
      scheduled() {
        scheduledRun = true;
      }
    }`,
	});
	t.teardown(() => mf.dispose());

	let res = await mf.dispatchFetch("http://localhost");
	t.is(await res.text(), "false");

	res = await mf.dispatchFetch("http://localhost/cdn-cgi/mf/scheduled");
	t.is(await res.text(), "ok");

	res = await mf.dispatchFetch("http://localhost");
	t.is(await res.text(), "true");
});

test("Miniflare: Listens on ipv6", async (t) => {
	const log = new TestLog(t);

	const mf = new Miniflare({
		log,
		modules: true,
		host: "*",
		script: `export default {
      fetch() {
        return new Response("Hello world");
      }
    }`,
	});
	t.teardown(() => mf.dispose());

	const url = await mf.ready;

	let response = await fetch(`http://localhost:${url.port}`);
	t.true(response.ok);

	response = await fetch(`http://[::1]:${url.port}`);
	t.true(response.ok);

	response = await fetch(`http://127.0.0.1:${url.port}`);
	t.true(response.ok);
});

test("Miniflare: getBindings() returns all bindings", async (t) => {
	const tmp = await useTmp(t);
	const blobPath = path.join(tmp, "blob.txt");
	await fs.writeFile(blobPath, "blob");
	const mf = new Miniflare({
		modules: true,
		script: `
    export class DurableObject {}
    export default { fetch() { return new Response(null, { status: 404 }); } }
    `,
		bindings: { STRING: "hello", OBJECT: { a: 1, b: { c: 2 } } },
		textBlobBindings: { TEXT: blobPath },
		dataBlobBindings: { DATA: blobPath },
		serviceBindings: { SELF: "" },
		d1Databases: ["DB"],
		durableObjects: { DO: "DurableObject" },
		kvNamespaces: ["KV"],
		queueProducers: ["QUEUE"],
		r2Buckets: ["BUCKET"],
	});
	let disposed = false;
	t.teardown(() => {
		if (!disposed) return mf.dispose();
	});

	interface Env {
		STRING: string;
		OBJECT: unknown;
		TEXT: string;
		DATA: ArrayBuffer;
		SELF: ReplaceWorkersTypes<Fetcher>;
		DB: D1Database;
		DO: ReplaceWorkersTypes<DurableObjectNamespace>;
		KV: ReplaceWorkersTypes<KVNamespace>;
		QUEUE: Queue<unknown>;
		BUCKET: ReplaceWorkersTypes<R2Bucket>;
	}
	const bindings = await mf.getBindings<Env>();

	t.like(bindings, {
		STRING: "hello",
		OBJECT: { a: 1, b: { c: 2 } },
		TEXT: "blob",
	});
	t.deepEqual(bindings.DATA, viewToBuffer(utf8Encode("blob")));

	const opts: util.InspectOptions = { colors: false };
	t.regex(util.inspect(bindings.SELF, opts), /name: 'Fetcher'/);
	t.regex(util.inspect(bindings.DB, opts), /name: 'D1Database'/);
	t.regex(util.inspect(bindings.DO, opts), /name: 'DurableObjectNamespace'/);
	t.regex(util.inspect(bindings.KV, opts), /name: 'KvNamespace'/);
	t.regex(util.inspect(bindings.QUEUE, opts), /name: 'WorkerQueue'/);
	t.regex(util.inspect(bindings.BUCKET, opts), /name: 'R2Bucket'/);

	// Check with WebAssembly binding (aren't supported by modules workers)
	// (base64 encoded module containing a single `add(i32, i32): i32` export)
	const addWasmModule =
		"AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABagsACgRuYW1lAgMBAAA=";
	const addWasmPath = path.join(tmp, "add.wasm");
	await fs.writeFile(addWasmPath, Buffer.from(addWasmModule, "base64"));
	await mf.setOptions({
		script:
			'addEventListener("fetch", (event) => event.respondWith(new Response(null, { status: 404 })));',
		wasmBindings: { ADD: addWasmPath },
	});
	const { ADD } = await mf.getBindings<{ ADD: WebAssembly.Module }>();
	const instance = new WebAssembly.Instance(ADD);
	assert(typeof instance.exports.add === "function");
	t.is(instance.exports.add(1, 2), 3);

	// Check bindings poisoned after dispose
	await mf.dispose();
	disposed = true;
	const expectations: ThrowsExpectation<Error> = {
		message:
			"Attempted to use poisoned stub. Stubs to runtime objects must be re-created after calling `Miniflare#setOptions()` or `Miniflare#dispose()`.",
	};
	t.throws(() => bindings.KV.get("key"), expectations);
});
test("Miniflare: getBindings() and friends return bindings for different workers", async (t) => {
	const mf = new Miniflare({
		workers: [
			{
				name: "a",
				modules: true,
				script: `
        export class DurableObject {}
        export default { fetch() { return new Response(null, { status: 404 }); } }
        `,
				d1Databases: ["DB"],
				durableObjects: { DO: "DurableObject" },
			},
			{
				// 2nd worker unnamed, to validate that not specifying a name when
				// getting bindings gives the entrypoint, not the unnamed worker
				script:
					'addEventListener("fetch", (event) => event.respondWith(new Response(null, { status: 404 })));',
				kvNamespaces: ["KV"],
				queueProducers: ["QUEUE"],
			},
			{
				name: "b",
				script:
					'addEventListener("fetch", (event) => event.respondWith(new Response(null, { status: 404 })));',
				r2Buckets: ["BUCKET"],
			},
		],
	});
	t.teardown(() => mf.dispose());

	// Check `getBindings()`
	let bindings = await mf.getBindings();
	t.deepEqual(Object.keys(bindings), ["DB", "DO"]);
	bindings = await mf.getBindings("");
	t.deepEqual(Object.keys(bindings), ["KV", "QUEUE"]);
	bindings = await mf.getBindings("b");
	t.deepEqual(Object.keys(bindings), ["BUCKET"]);
	await t.throwsAsync(() => mf.getBindings("c"), {
		instanceOf: TypeError,
		message: '"c" worker not found',
	});

	const unboundExpectations = (name: string): ThrowsExpectation<TypeError> => ({
		instanceOf: TypeError,
		message: `"${name}" unbound in "c" worker`,
	});

	// Check `getD1Database()`
	let binding: unknown = await mf.getD1Database("DB");
	t.not(binding, undefined);
	let expectations = unboundExpectations("DB");
	await t.throwsAsync(() => mf.getD1Database("DB", "c"), expectations);

	// Check `getDurableObjectNamespace()`
	binding = await mf.getDurableObjectNamespace("DO");
	t.not(binding, undefined);
	expectations = unboundExpectations("DO");
	await t.throwsAsync(
		() => mf.getDurableObjectNamespace("DO", "c"),
		expectations
	);

	// Check `getKVNamespace()`
	binding = await mf.getKVNamespace("KV", "");
	t.not(binding, undefined);
	expectations = unboundExpectations("KV");
	await t.throwsAsync(() => mf.getKVNamespace("KV", "c"), expectations);

	// Check `getQueueProducer()`
	binding = await mf.getQueueProducer("QUEUE", "");
	t.not(binding, undefined);
	expectations = unboundExpectations("QUEUE");
	await t.throwsAsync(() => mf.getQueueProducer("QUEUE", "c"), expectations);

	// Check `getR2Bucket()`
	binding = await mf.getR2Bucket("BUCKET", "b");
	t.not(binding, undefined);
	expectations = unboundExpectations("BUCKET");
	await t.throwsAsync(() => mf.getQueueProducer("BUCKET", "c"), expectations);
});
