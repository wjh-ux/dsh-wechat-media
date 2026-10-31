import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Route-level smoke tests.
 *
 * Why this file exists: on 2026-10-31 three separate bugs reached a release in the same shape - a name used inside the
 * plugin's `apply()` that was never declared or never passed along (`keilBuildTool`, `uv4`, `idfInfo`). `node --check`
 * only sees syntax, and every unit test in this repo calls pure functions that never touch those closures. So this file
 * does the one thing that would have caught all three: it *starts the plugin* and *calls it the way the chat does*.
 *
 * Nothing here needs credentials, a network, or hardware: the assertions are about wiring (did it register? did it
 * answer?) rather than about what a compiler produced.
 */

/** A permissive stand-in for the host context: records what the plugin registers, answers what it asks. */
function fakeCtx() {
  const tools = [];
  const routes = [];
  const effects = [];
  const warns = [];
  const injections = [];

  const logger = {
    info: () => {},
    warn: (...args) => warns.push(args.join(" ")),
    error: (...args) => warns.push(args.join(" ")),
    debug: () => {},
    trace: () => {},
  };

  const makeInjectTarget = (deps) => {
    // The shape the plugin expects: `webCtx.effect(fn)` to schedule, and `webCtx.webServer.register(route)` to mount.
    // (Getting this nesting wrong the first time is why the probe found 67 tools and 0 routes.)
    const target = {
      tools: { register: (definition) => { tools.push(definition); return () => {}; } },
      effect: (fn) => { effects.push(fn); try { fn(); } catch { /* a failing effect is what the host would log */ } },
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    // Anything else the plugin asks for answers with a chainable no-op: `approvalCtx.on(...)`, `x.y.z()` and friends are
    // host services this test has no opinion about, and a missing one must not look like a plugin defect.
    const noop = new Proxy(function noop() {}, {
      get: () => noop,
      apply: () => undefined,
    });
    return new Proxy(target, {
      get: (t, key) => (key in t ? t[key] : noop),
      has: () => true,
    });
  };

  const ctx = {
    logger,
    inject(deps, callback) {
      injections.push(deps);
      callback(makeInjectTarget(deps));
    },
    effect(fn, label) { effects.push(fn); try { fn(); } catch { /* same */ } return () => {}; },
    on() { return () => {}; },
    get() { return undefined; },
    agents: {},
    baseUrl: "http://127.0.0.1:0",
  };
  return { ctx, tools, routes, effects, warnings: warns, injections };
}

/** A response object the plugin's handlers can write to, keeping enough of `http.ServerResponse`. */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status, headers) { state.status = status; state.headers = headers ?? {}; return res; },
    setHeader(name, value) { state.headers[name] = value; },
    end(chunk) { if (chunk !== undefined) state.body += String(chunk); state.done = true; return res; },
    write(chunk) { state.body += String(chunk); return true; },
    get statusCode() { return state.status; },
    set statusCode(value) { state.status = value; },
  };
  return { res, state };
}

/** A request that looks like a browser on the same origin - the plugin refuses cross-site writes. */
function fakeRequest({ method = "GET", url = "/", body = "", headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = {
    method,
    url,
    headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387", ...lower },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body, "utf8");
    },
    on() { return req; },
    once() { return req; },
  };
  return req;
}

async function startPlugin() {
  const home = mkdtempSync(join(tmpdir(), "dsh-smoke-"));
  const plugin = await import("../index.js");
  const harness = fakeCtx();
  plugin.apply(harness.ctx, { dshHome: home, stateDir: join(home, "state") });
  // Tool registration happens inside an async IIFE (`ctx.inject(["tools"], ...)`), so give it a turn to finish.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { ...harness, home, plugin };
}

await test("the plugin starts, registers its tools and its routes", async () => {
  const { tools, routes, injections, home } = await startPlugin();
  try {
    const names = tools.map((tool) => tool?.name ?? tool?.definition?.name).filter(Boolean);
    assert.ok(names.length >= 40, `expected the full tool set, got ${names.length}: ${names.slice(0, 8).join(", ")}…`);
    for (const required of ["project_build", "keil_build", "serial_flash", "serial_monitor", "ssh_exec", "office_read"]) {
      assert.ok(names.includes(required), `${required} should be registered`);
    }
    // Every tool has a description and an execute - a definition that lost either is broken before it is ever called.
    for (const tool of tools) {
      assert.equal(typeof tool.execute, "function", `${tool.name} has no execute`);
      assert.ok(String(tool.description ?? "").length > 10, `${tool.name} has no description`);
    }

    const paths = routes.map((route) => route?.path).filter(Boolean);
    assert.ok(paths.length >= 15, `expected the route table, got ${paths.length}`);
    for (const required of ["/dsh-wechat-media/state", "/dsh-wechat-media/prefs", "/dsh-wechat-media/keil"]) {
      assert.ok(paths.includes(required), `${required} should be registered`);
    }
    assert.ok(injections.some((deps) => deps.includes("tools")), "tools injection happened");
    assert.ok(injections.some((deps) => deps.includes("webServer")), "web injection happened");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("the state route answers with JSON, and cross-site writes are refused", async () => {
  const { routes, home } = await startPlugin();
  try {
    const state = routes.find((route) => route.path === "/dsh-wechat-media/state");
    assert.ok(state, "/state should exist");
    const { res, state: out } = fakeResponse();
    await state.handler(fakeRequest({ url: "/dsh-wechat-media/state" }), res);
    assert.equal(out.status, 200);
    const payload = JSON.parse(out.body);
    assert.ok(payload.version, "the answer carries a version");
    assert.equal(typeof payload, "object");

    // The same route from a foreign origin: a page anywhere could otherwise flip a preference with an <img> tag.
    const foreign = fakeResponse();
    await state.handler(
      fakeRequest({ url: "/dsh-wechat-media/state", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
      foreign.res,
    );
    assert.equal(foreign.state.status, 403, "cross-site request refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("project_build runs through the tool layer without a name that does not exist", async () => {
  // This is the regression that shipped three times: the plan is assembled inside `apply()` and used in `execute()`, so
  // only a real call reaches it. An unconfigured CMake project gets as far as the plan (and then fails at cmake), which
  // is exactly far enough for a ReferenceError to surface.
  const { tools, home } = await startPlugin();
  try {
    const build = tools.find((tool) => tool?.name === "project_build");
    assert.ok(build, "project_build should be registered");
    // A Makefile project, not CMake: the CMake path returns early from a failed `configure` before it ever builds a plan,
    // so a mutation there goes unnoticed. `buildPlan` for `make` is reached directly - which is the line where a name that
    // escaped its scope has to throw.
    const dir = join(home, "make-fixture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Makefile"), "all:\n\t@echo fixture\n", "utf8");

    // `project_build` is gated (`prefs.keil.enabled`), and a fresh state directory has the gate closed - the first run of
    // this test passed every mutation for exactly that reason. Open it the way `/keil on` does, by writing prefs.json.
    const stateDir = join(home, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "prefs.json"), JSON.stringify({ keil: { enabled: true }, serial: { enabled: true } }), "utf8");

    const answer = await build.execute({ dir, action: "build" });
    assert.equal(typeof answer, "string", "the tool answers with text, not undefined");
    assert.ok(answer.length > 0);
    // The three failures that reached releases all looked like this in the answer.
    assert.doesNotMatch(answer, /is not defined/, `a name escaped its scope: ${answer.slice(0, 300)}`);
    assert.doesNotMatch(answer, /Cannot read properties of undefined/);
    assert.doesNotMatch(answer, /undefined is not a function/);

    // And the flash branch, which is a different closure: `uv4` used to be declared inside the build branch and read here,
    // so only a flash call reached the ReferenceError. `flasher: "stcgal"` without a hex fails inside the planner before
    // anything is spawned - no hardware, no subprocess, just the code path.
    const flashAnswer = await build.execute({ dir, action: "flash", flasher: "stcgal" });
    assert.equal(typeof flashAnswer, "string");
    assert.doesNotMatch(flashAnswer, /is not defined/, `the flash path escaped its scope: ${flashAnswer.slice(0, 300)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The plugin starts monitors and a scheduler inside `apply()`. That is right for the plugin and wrong for a test process:
// the event loop stays busy, `node test/smoke.test.mjs` never exits, and CI sits at "Run every suite" with no further
// output (measured: 13 minutes, twice, on the two runs that shipped 1.20.0). One turn is enough for the reporter to flush
// its summary, then this file leaves on its own terms.
setImmediate(() => process.exit(process.exitCode ?? 0));