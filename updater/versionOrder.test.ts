// npx tsx --test updater/versionOrder.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideUpdate, parseVersion } from "./versionOrder.js";

test("the 2.0 cutover installs, a later 1.x never does, 2.x moves on", () => {
    assert.equal(decideUpdate("v1.0.35", "v2.0.0"), "install");
    assert.equal(decideUpdate("v2.0.0", "v1.0.36"), "older");
    assert.equal(decideUpdate("v2.0.0", "v2.0.1"), "install");
});

test("numeric, not text, order", () => {
    assert.equal(decideUpdate("v1.0.9", "v1.0.10"), "install");
    assert.equal(decideUpdate("v1.0.10", "v1.0.9"), "older");
    assert.equal(decideUpdate("v1.9.0", "v1.10.0"), "install");
});

test("same version is current", () => {
    assert.equal(decideUpdate("v1.0.35", "v1.0.35"), "current");
    assert.equal(decideUpdate("v1.0.35", "1.0.35"), "current");
});

test("nothing usable installed still installs, as before", () => {
    assert.equal(decideUpdate("Not Installed", "v1.0.36"), "install");
    // dpkg left it half-installed: the same version goes in again.
    assert.equal(decideUpdate("v1.0.36 (half-installed)", "v1.0.36"), "install");
});

test("a tag that is not a version installs nothing", () => {
    assert.equal(decideUpdate("v2.0.0", "latest"), "unreadable");
    assert.equal(parseVersion("v2.0.0-rc1"), null);
});
