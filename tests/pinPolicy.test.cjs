const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../vscode/node_modules/typescript");
const root = path.join(__dirname, "../src/stable/src/vs/workbench/contrib/codexConductor");
function load(file) {
    const context = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        context,
    );
    return context.exports;
}
const { PinPolicyState, validatePinMap } = load(path.join(root, "common/pinPolicy.ts"));
const pin = { editor: { version: "1.0.0", url: "https://example.invalid/editor.vsix" } };
const snapshot = (pins) => ({
    origin: "https://example.invalid/project.git",
    branch: "main",
    commit: "a".repeat(40),
    pins,
});
function accept(state, pins) {
    const remote = snapshot(pins);
    state.acceptRemote(state.beginRemote(remote.origin, remote.branch), remote);
    state.select(pin);
}
test("explicit remote unpin survives persistence and offline startup", () => {
    const state = new PinPolicyState("enforce");
    accept(state, {});
    const restarted = new PinPolicyState("enforce", state.state);
    restarted.select(pin);
    assert.equal(Object.keys(restarted.state.pins).length, 0);
});
test("offline discovery makes no decision and preserves accepted pins", () => {
    const state = new PinPolicyState("enforce");
    accept(state, pin);
    state.beginRemote(snapshot(pin).origin, "main"); // request fails; do not accept an empty response
    state.select({});
    assert.equal(state.state.pins.editor.version, "1.0.0");
});
test("out-of-order responses and wrong repositories cannot overwrite state", () => {
    const state = new PinPolicyState("enforce");
    const a = state.beginRemote("repo", "main");
    const b = state.beginRemote("repo", "main");
    assert.equal(state.acceptRemote(a, { ...snapshot(pin), origin: "repo" }), false);
    assert.equal(state.acceptRemote(b, snapshot(pin)), false);
    assert.equal(state.acceptRemote(b, { ...snapshot({}), origin: "repo" }), true);
});
test("invalid maps are not interpreted as unpins", () => {
    for (const pins of [
        null,
        [],
        { editor: { version: "", url: "" } },
        { editor: { version: "1" } },
    ])
        assert.throws(() => validatePinMap(pins));
});
test("ignore mode ignores pins offline and rollback drops previous remote authority", () => {
    const state = new PinPolicyState("ignore");
    accept(state, pin);
    assert.equal(Object.keys(state.state.pins).length, 0);
    const rollback = new PinPolicyState("enforce", state.state);
    rollback.select({});
    assert.equal(rollback.state.remote, undefined);
});
test("failure persists, same state does not retry, explicit retry advances generation", () => {
    const state = new PinPolicyState("enforce");
    state.select(pin);
    state.block(state.state.generation, "offline");
    const restarted = new PinPolicyState("enforce", state.state);
    restarted.select(pin);
    assert.equal(restarted.state.phase, "blocked");
    const generation = restarted.state.generation;
    restarted.retry();
    assert.equal(restarted.state.phase, "resolving");
    assert.ok(restarted.state.generation > generation);
});
// Exercise the real orchestration method with controlled package/host services.
const file = path.join(root, "browser/codexConductor.ts");
const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
);
const cls = source.statements.find((s) => ts.isClassDeclaration(s));
const method = cls.members
    .find((m) => m.name?.getText(source) === "reconcilePolicy")
    .getText(source);
const ctx = { CONDUCTOR_PROFILE_ICON: "repo-pinned" };
vm.runInNewContext(
    ts.transpileModule(`class Harness {${method}};globalThis.Harness=Harness;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    ctx,
);
function harness(state) {
    const h = new ctx.Harness();
    h.policy = state;
    h.arbiter = { call: async () => true };
    h.workspaceContextService = { getWorkspace: () => ({ id: "project" }) };
    h.persistPolicy = () => {};
    h.storageService = { flush: async () => {} };
    const normal = { id: "default", name: "Default", isDefault: true };
    const pinned = { id: "pinned", name: "Pinned", icon: "repo-pinned" };
    h.userDataProfileService = { currentProfile: normal };
    h.userDataProfilesService = { defaultProfile: normal, profiles: [normal, pinned] };
    h.removeCurrentProjectFromAssociations = () => {};
    h.addProfileAssociation = () => {};
    h.resolveProfileName = () => pinned.name;
    h.getCoreExtensionEntries = () => [];
    h.extensionManagementService = { getInstalled: async () => [] };
    h.extensionService = { whenInstalledExtensionsRegistered: async () => {}, extensions: [] };
    h.validateProfileExtensions = async () => true;
    h.installPinnedExtensions = async () => {};
    h.backfillCoreExtensions = async () => {};
    h.switches = [];
    h.switchProfileAndReload = async (target) => h.switches.push(target.id);
    h.notificationService = { warn() {} };
    return h;
}
test("in-flight installation cannot switch after remote unpin", async () => {
    const state = new PinPolicyState("enforce");
    state.select(pin);
    const h = harness(state);
    h.validateProfileExtensions = async () => false;
    let release, entered;
    const started = new Promise((r) => (entered = r));
    const gate = new Promise((r) => (release = r));
    h.installPinnedExtensions = async () => {
        entered();
        await gate;
    };
    const work = h.reconcilePolicy();
    await started;
    accept(state, {});
    release();
    await work;
    assert.equal(h.switches.length, 0);
});
test("pending transition that failed across restart blocks instead of reloading again", async () => {
    const state = new PinPolicyState("enforce");
    state.select(pin);
    state.switching(state.state.generation, "Pinned");
    const h = harness(new PinPolicyState("enforce", state.state));
    await h.reconcilePolicy();
    await h.reconcilePolicy();
    assert.equal(h.policy.state.phase, "blocked");
    assert.equal(h.switches.length, 0);
});
test("already-running unpinned state needs no reload", async () => {
    const h = harness(new PinPolicyState("enforce"));
    await h.reconcilePolicy();
    await h.reconcilePolicy();
    assert.equal(h.policy.state.phase, "ready");
    assert.equal(h.switches.length, 0);
});
test("offline missing package enters stable failure and does not repeat installation", async () => {
    const state = new PinPolicyState("enforce");
    state.select(pin);
    const h = harness(state);
    let attempts = 0;
    h.validateProfileExtensions = async () => false;
    h.installPinnedExtensions = async () => {
        attempts++;
        throw Error("offline");
    };
    await h.reconcilePolicy();
    await h.reconcilePolicy();
    assert.equal(attempts, 1);
    assert.equal(h.switches.length, 0);
    assert.equal(state.state.phase, "blocked");
});

const { PinPolicyArbiter } = load(
    path.join(__dirname, "../src/stable/src/vs/platform/codexPinPolicy/common/pinPolicyArbiter.ts"),
);
test("two windows cannot own the same workspace transition", () => {
    const arbiter = new PinPolicyArbiter();
    const epoch = arbiter.acquire("workspace", "window-a");
    assert.equal(arbiter.acquire("workspace", "window-b"), undefined);
    const ticket = arbiter.begin("workspace");
    assert.equal(arbiter.accept("workspace", ticket), true);
    assert.equal(arbiter.valid("workspace", "window-a", epoch), false);
    assert.equal(arbiter.acquire("workspace", "window-b"), undefined);
    arbiter.release("workspace", "window-a");
    assert.notEqual(arbiter.acquire("workspace", "window-b"), undefined);
    assert.equal(arbiter.acquire("workspace", "window-c"), undefined);
});
test("cross-window discovery rejects old responses and repeated snapshots keep leases", () => {
    const arbiter = new PinPolicyArbiter();
    const a = arbiter.begin("workspace");
    const b = arbiter.begin("workspace");
    assert.equal(arbiter.accept("workspace", a), false);
    assert.equal(arbiter.accept("workspace", b), true);
    const lease = arbiter.acquire("workspace", "window");
    const c = arbiter.begin("workspace");
    assert.equal(arbiter.accept("workspace", c, false), true);
    assert.equal(arbiter.valid("workspace", "window", lease), true);
    assert.equal(arbiter.accept("workspace", c), false);
});

const discoveryMethod = cls.members
    .find((m) => m.name?.getText(source) === "awaitDiscovery")
    .getText(source);
const discoveryContext = { timeout: () => new Promise(() => {}) };
vm.runInNewContext(
    ts.transpileModule(
        `class DiscoveryHarness {fileService={exists:async()=>true}; ${discoveryMethod}};globalThis.DiscoveryHarness=DiscoveryHarness;`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    discoveryContext,
);
test("normal startup waits for discovery before profile recovery", async () => {
    const h = new discoveryContext.DiscoveryHarness();
    h.metadataUri = {};
    h.ignorePins = false;
    h.discoveryFinished = false;
    let finish;
    h.discovery = new Promise((resolve) => {
        finish = resolve;
    });
    let completed = false;
    const waiting = h.awaitDiscovery().then(() => {
        completed = true;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    h.discoveryFinished = true;
    finish();
    await waiting;
    assert.equal(completed, true);
});
test("ignore policy does not depend on network discovery", async () => {
    const h = new discoveryContext.DiscoveryHarness();
    h.metadataUri = {};
    h.ignorePins = true;
    await h.awaitDiscovery();
});
test("same-version legacy running packages are not accepted as coordinated packages", async () => {
    const state = new PinPolicyState("ignore");
    const h = harness(state);
    h.ignorePins = true;
    const id = "project-accelerate.codex-editor-extension";
    h.getCoreExtensionEntries = () => [id];
    h.extensionManagementService.getInstalled = async () => [
        { identifier: { id }, manifest: { version: "1", codexProjectPinPolicyVersion: 2 } },
    ];
    h.extensionService.extensions = [{ identifier: { value: id }, version: "1" }];
    await h.reconcilePolicy();
    assert.equal(h.switches.length, 1);
    assert.equal(state.state.phase, "switching");
});

test("offline branch change cannot reuse another branch pin snapshot", () => {
    const state = new PinPolicyState("enforce");
    accept(state, pin);
    state.beginRemote(snapshot(pin).origin, "other");
    state.select({});
    assert.equal(state.state.remote, undefined);
    assert.equal(Object.keys(state.state.pins).length, 0);
});
test("failed startup discovery never releases recovery with a false empty decision", async () => {
    const h = new discoveryContext.DiscoveryHarness();
    h.metadataUri = {};
    h.ignorePins = false;
    h.discoveryFinished = true;
    h.discoveryError = "invalid remote metadata";
    await assert.rejects(h.awaitDiscovery(), /invalid remote metadata/);
});
test("remote change while recovery state is flushing prevents the old reload", async () => {
    const state = new PinPolicyState("enforce");
    state.select(pin);
    const h = harness(state);
    h.storageService.flush = async () => accept(state, {});
    await h.reconcilePolicy();
    assert.equal(h.switches.length, 0);
});

// Regression tests for the cross-repository review findings.
test("healthy packages recover from a persisted temporary block without reloading", async () => {
    const state = new PinPolicyState("enforce");
    accept(state, {});
    state.block(state.state.generation, "startup timeout");
    const restarted = new PinPolicyState("enforce", state.state);
    accept(restarted, {});
    const h = harness(restarted);
    await h.reconcilePolicy();
    assert.equal(restarted.state.phase, "ready");
    assert.equal(h.switches.length, 0);
});
test("a source change immediately fences a paused installation", async () => {
    const state = new PinPolicyState("enforce");
    accept(state, pin);
    const h = harness(state);
    h.validateProfileExtensions = async () => false;
    let entered, release;
    const started = new Promise((r) => (entered = r));
    const gate = new Promise((r) => (release = r));
    h.installPinnedExtensions = async () => {
        entered();
        await gate;
    };
    const work = h.reconcilePolicy();
    await started;
    state.beginRemote("new-origin", "other-branch");
    release();
    await work;
    assert.equal(h.switches.length, 0);
});
test("accepted remote policy preserves explicit unpublished admin intent", () => {
    const state = new PinPolicyState("enforce");
    accept(state, {});
    state.state.localIntent = pin;
    accept(state, {});
    assert.equal(state.state.pins.editor.version, "1.0.0");
    state.state.localIntent = {};
    accept(state, pin);
    assert.equal(Object.keys(state.state.pins).length, 0);
});
test("source changes discard admin intent from the previous repository", () => {
    const state = new PinPolicyState("enforce");
    accept(state, {});
    state.state.localIntent = pin;
    state.beginRemote("other", "main");
    state.select({});
    assert.equal(state.state.localIntent, undefined);
    assert.equal(Object.keys(state.state.pins).length, 0);
});
test("non-project folders do not wait for Frontier", async () => {
    const h = new discoveryContext.DiscoveryHarness();
    h.metadataUri = {};
    h.fileService = { exists: async () => false };
    await h.awaitDiscovery();
});
test("a discovery deadline falls back without persisting a block", async () => {
    const h = new discoveryContext.DiscoveryHarness();
    h.metadataUri = {};
    h.discovery = new Promise(() => {});
    h.logService = { warn() {} };
    discoveryContext.timeout = async () => {};
    await h.awaitDiscovery();
    assert.equal(h.discoveryFinished, true);
    discoveryContext.timeout = () => new Promise(() => {});
});

function channelFixture(io = {}) {
    const helper = load(
        path.join(
            __dirname,
            "../src/stable/src/vs/platform/codexPinPolicy/common/metadataPinTextEdit.ts",
        ),
    );
    const context = {
        exports: {},
        require(id) {
            if (id === "fs") {
                return { promises: io };
            }
            if (id.includes("pinPolicyArbiter")) {
                return { PinPolicyArbiter };
            }
            if (id.includes("metadataPinTextEdit")) {
                return helper;
            }
            if (id.includes("event")) {
                return {
                    Emitter: class {
                        listeners = [];
                        event = (listener) => {
                            this.listeners.push(listener);
                            return { dispose() {} };
                        };
                        fire(event) {
                            this.listeners.forEach((listener) => listener(event));
                        }
                    },
                };
            }
            throw Error(id);
        },
    };
    vm.runInNewContext(
        ts.transpileModule(
            fs.readFileSync(
                path.join(
                    __dirname,
                    "../src/stable/src/vs/platform/codexPinPolicy/node/pinPolicyChannel.ts",
                ),
                "utf8",
            ),
            { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        context,
    );
    return new context.exports.PinPolicyChannel();
}
async function channelAccept(channel, pins) {
    const source = { origin: "repo", branch: "main" };
    const request = await channel.call("window", "begin", { workspace: "project", source });
    const remote = { ...snapshot(pins), ...source };
    assert.equal(
        await channel.call("window", "accept", { workspace: "project", request, snapshot: remote }),
        true,
    );
    return remote;
}
test("shared-process persistence rejects a superseded remote write", async () => {
    let writes = 0;
    const channel = channelFixture({ readFile: async () => "{}", writeFile: async () => writes++ });
    const old = await channelAccept(channel, pin);
    await channelAccept(channel, {});
    await assert.rejects(
        channel.call("window", "writePins", {
            workspace: "project",
            snapshot: old,
            pins: pin,
            filePath: "/metadata.json",
        }),
        /superseded/,
    );
    assert.equal(writes, 0);
});
test("acceptance cannot overtake an in-flight metadata read and write", async () => {
    let contents = '{"meta":{"other":1e2,"pinnedExtensions":{}}}';
    let entered, release;
    const started = new Promise((r) => (entered = r));
    const gate = new Promise((r) => (release = r));
    const channel = channelFixture({
        readFile: async () => {
            entered();
            await gate;
            return contents;
        },
        writeFile: async (_path, text) => {
            contents = text;
        },
    });
    const old = await channelAccept(channel, pin);
    const write = channel.call("window", "writePins", {
        workspace: "project",
        snapshot: old,
        pins: pin,
        filePath: "/metadata.json",
    });
    await started;
    let accepted = false;
    const newer = channelAccept(channel, {}).then((remote) => {
        accepted = true;
        return remote;
    });
    await Promise.resolve();
    assert.equal(accepted, false);
    release();
    await write;
    const remote = await newer;
    await channel.call("window", "writePins", {
        workspace: "project",
        snapshot: remote,
        pins: {},
        filePath: "/metadata.json",
    });
    assert.equal(contents, '{"meta":{"other":1e2,"pinnedExtensions":{}}}');
});
test("renderer disconnect releases transition ownership without an explicit retry", async () => {
    const channel = channelFixture();
    await channel.call("old-window", "acquire", { workspace: "project", owner: "old-session" });
    channel.disconnect("old-window");
    const lease = await channel.call("new-window", "acquire", {
        workspace: "project",
        owner: "new-session",
    });
    assert.equal(typeof lease, "number");
    assert.equal(
        await channel.call("old-window", "valid", {
            workspace: "project",
            owner: "old-session",
            epoch: lease,
        }),
        false,
    );
});

test("pending admin removal is protected from another window remote write until publication", async () => {
    let contents = JSON.stringify({ meta: { pinnedExtensions: pin }, other: 42 });
    const channel = channelFixture({
        readFile: async () => contents,
        writeFile: async (_path, text) => {
            contents = text;
        },
    });
    const remote = await channelAccept(channel, pin);
    await channel.call("admin", "setIntent", {
        workspace: "project",
        filePath: "/metadata.json",
        pins: {},
    });
    await channel.call("other-window", "writePins", {
        workspace: "project",
        filePath: "/metadata.json",
        snapshot: remote,
        pins: pin,
    });
    assert.equal(Object.keys(JSON.parse(contents).meta.pinnedExtensions).length, 0);
    assert.equal(await channel.call("admin", "clearIntent", { workspace: "project" }), false);
    await channelAccept(channel, {});
    assert.equal(await channel.call("admin", "clearIntent", { workspace: "project" }), true);
});
test("disconnect rejects queued work from the old renderer", async () => {
    let entered, release;
    const started = new Promise((r) => (entered = r));
    const gate = new Promise((r) => (release = r));
    const channel = channelFixture({
        readFile: async () => {
            entered();
            await gate;
            return "{}";
        },
        writeFile: async () => {},
    });
    const remote = await channelAccept(channel, pin);
    const writing = channel.call("other", "writePins", {
        workspace: "project",
        snapshot: remote,
        pins: pin,
        filePath: "/metadata.json",
    });
    await started;
    const queued = channel.call("closing", "acquire", { workspace: "project", owner: "old" });
    const rejection = assert.rejects(queued, /disconnected/);
    channel.disconnect("closing");
    release();
    await writing;
    await rejection;
    assert.equal(
        typeof (await channel.call("new", "acquire", { workspace: "project", owner: "new" })),
        "number",
    );
});
test("ignore-mode acceptance normalizes malformed remote pins before validation", async () => {
    const constructor = cls.members.find((m) => ts.isConstructorDeclaration(m));
    let handler;
    function visit(node) {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(source).endsWith("registerCommand") &&
            node.arguments[0]?.text === "codex.conductor.acceptRemotePinSnapshot"
        ) {
            handler = node.arguments[1].getText(source);
        }
        ts.forEachChild(node, visit);
    }
    visit(constructor);
    const context = { validatePinMap };
    vm.runInNewContext(
        ts.transpileModule(
            "class Acceptance {accept=" + handler + "};globalThis.Acceptance=Acceptance;",
            { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        context,
    );
    const h = new context.Acceptance();
    h.ignorePins = true;
    h.policySession = "session";
    h.remoteCheck = { request: 1, origin: "repo", branch: "main" };
    h.policy = new PinPolicyState("ignore");
    h.persistPolicy = () => {};
    h.policyStatus = () => h.policy.state;
    h.workspaceContextService = { getWorkspace: () => ({ id: "project" }) };
    h.arbiter = {
        call: async (_command, arg) => {
            h.policy.acceptRemote(
                h.policy.beginRemote(arg.snapshot.origin, arg.snapshot.branch),
                arg.snapshot,
            );
            h.policy.select({});
            return true;
        },
    };
    const result = await h.accept(null, {
        session: "session",
        request: 1,
        snapshot: {
            origin: "repo",
            branch: "main",
            commit: "a".repeat(40),
            pins: { editor: { version: "", url: "" } },
        },
    });
    assert.equal(result.accepted, true);
    assert.equal(Object.keys(result.pins).length, 0);
});

test("reconnecting the coordinator does not reset an interrupted transition into another install", () => {
    const eventMethod = cls.members
        .find((m) => m.name?.getText(source) === "onPinPolicyEvent")
        .getText(source);
    const context = {};
    vm.runInNewContext(
        ts.transpileModule(`class Events {${eventMethod}};globalThis.Events=Events;`, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        context,
    );
    const h = new context.Events();
    h.policy = new PinPolicyState("enforce");
    accept(h.policy, pin);
    const generation = h.policy.state.generation;
    h.policy.preparing(generation, "Pinned");
    h.workspaceContextService = { getWorkspace: () => ({ id: "project" }) };
    h.persistPolicy = () => {};
    h.arbitrationEpoch = 0;
    h.onPinPolicyEvent({ workspace: "project", invalidate: true, snapshot: snapshot(pin) });
    assert.equal(h.policy.state.phase, "preparing");
    assert.equal(h.policy.state.generation, generation);
    h.activeRecoveryGeneration = generation;
    h.onPinPolicyEvent({ workspace: "project", invalidate: true, snapshot: snapshot(pin) });
    assert.equal(h.policy.state.phase, "resolving");
    assert.ok(h.policy.state.generation > generation);
});
test("a late IPC acknowledgement cannot replay pins over a newer unpin event", async () => {
    let handler;
    function visit(node) {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(source).endsWith("registerCommand") &&
            node.arguments[0]?.text === "codex.conductor.acceptRemotePinSnapshot"
        ) {
            handler = node.arguments[1].getText(source);
        }
        ts.forEachChild(node, visit);
    }
    visit(cls.members.find((m) => ts.isConstructorDeclaration(m)));
    const context = { validatePinMap };
    vm.runInNewContext(
        ts.transpileModule("class Accept {invoke=" + handler + "};globalThis.Accept=Accept;", {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        context,
    );
    const h = new context.Accept();
    h.policy = new PinPolicyState("enforce");
    h.policySession = "session";
    h.remoteCheck = { origin: snapshot(pin).origin, branch: "main", request: 1 };
    h.workspaceContextService = { getWorkspace: () => ({ id: "project" }) };
    h.policyStatus = () => h.policy.state;
    h.arbiter = {
        call: async () => {
            accept(h.policy, {});
            return true;
        },
    };
    const result = await h.invoke(null, {
        session: "session",
        request: 1,
        snapshot: snapshot(pin),
    });
    assert.equal(result.accepted, false);
    assert.equal(Object.keys(h.policy.state.remote.pins).length, 0);
});
test("project update resets unpublished intent before applying its remote snapshot", async () => {
    let contents = "{}";
    const channel = channelFixture({
        readFile: async () => contents,
        writeFile: async (_path, text) => {
            contents = text;
        },
    });
    const remote = await channelAccept(channel, {});
    await channel.call("admin", "setIntent", {
        workspace: "project",
        filePath: "/metadata.json",
        pins: pin,
    });
    await channel.call("updated-project", "resetIntent", { workspace: "project" });
    await channelAccept(channel, {});
    await channel.call("updated-project", "writePins", {
        workspace: "project",
        filePath: "/metadata.json",
        snapshot: remote,
        pins: {},
    });
    assert.equal(Object.keys(JSON.parse(contents).meta.pinnedExtensions).length, 0);
});

test("Project Update can stage ignored malformed pins without blocking open", async () => {
    let handler;
    function visit(node) {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(source).endsWith("registerCommand") &&
            node.arguments[0]?.text === "codex.conductor.stageProjectPinSnapshot"
        ) {
            handler = node.arguments[1].getText(source);
        }
        ts.forEachChild(node, visit);
    }
    visit(cls.members.find((m) => ts.isConstructorDeclaration(m)));
    const context = {
        PinPolicyState,
        URI: { parse: () => ({ scheme: "file", toString: () => "/project" }) },
        StorageScope: { APPLICATION: 0 },
        StorageTarget: { MACHINE: 0 },
    };
    vm.runInNewContext(
        ts.transpileModule("class Stage {invoke=" + handler + "};globalThis.Stage=Stage;", {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        context,
    );
    const h = new context.Stage();
    h.ignorePins = true;
    let staged;
    h.storageService = {
        store: (_key, value) => {
            staged = JSON.parse(value);
        },
        flush: async () => {},
    };
    await h.invoke(null, {
        workspace: "file:///project",
        snapshot: snapshot({ editor: { version: "", url: "" } }),
    });
    assert.equal(Object.keys(staged.pins).length, 0);
});

test("profile recovery waits until accepted metadata is actually saved", async () => {
    const state = new PinPolicyState("enforce");
    accept(state, pin);
    const h = harness(state);
    h.arbiter = { call: async () => false };
    await h.reconcilePolicy();
    assert.equal(state.state.phase, "blocked");
    assert.match(state.state.error, /must be saved/);
    assert.equal(h.switches.length, 0);
    h.arbiter = { call: async () => true };
    await h.reconcilePolicy();
    assert.equal(h.switches.length, 1);
});
test("offline cached snapshots can finish persistence after a shared-process restart", async () => {
    let contents = JSON.stringify({ meta: { pinnedExtensions: pin } });
    const channel = channelFixture({
        readFile: async () => contents,
        writeFile: async (_path, text) => {
            contents = text;
        },
    });
    await channel.call("window", "begin", {
        workspace: "project",
        source: { branch: "main", origin: "repo" },
    });
    const remote = { ...snapshot({}), origin: "repo" };
    await channel.call("window", "writePins", {
        workspace: "project",
        filePath: "/metadata.json",
        snapshot: remote,
        pins: {},
    });
    assert.equal(Object.keys(JSON.parse(contents).meta.pinnedExtensions).length, 0);
    assert.equal(
        await channel.call("window", "isSaved", { workspace: "project", snapshot: remote }),
        true,
    );
});
