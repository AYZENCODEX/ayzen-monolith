/** FIN F12: the unhandled-rejection guard logs and keeps the process alive; installs once. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { describeRejection, installProcessGuards } from "./process-guards";

function fakeProcess(env: Record<string, string> = {}) {
  const emitter = new EventEmitter() as EventEmitter & { env: Record<string, string>; exit: (c: number) => void; exitCode?: number };
  emitter.env = env;
  emitter.exit = (code: number) => { emitter.exitCode = code; };
  return emitter;
}

describe("F12 process guards", () => {
  it("describes Error, string and object reasons", () => {
    assert.equal(describeRejection(new Error("e")).message, "e");
    assert.equal(describeRejection("s").message, "s");
    assert.equal(describeRejection({ a: 1 }).message, '{"a":1}');
  });

  it("installs once and does not exit by default", () => {
    const proc = fakeProcess();
    assert.equal(installProcessGuards(proc as unknown as NodeJS.Process), true);
    assert.equal(installProcessGuards(proc as unknown as NodeJS.Process), false);
    assert.equal(proc.listenerCount("unhandledRejection"), 1);
    proc.emit("unhandledRejection", new Error("stray"));
    assert.equal(proc.exitCode, undefined);
  });

  it("exits 1 when UNHANDLED_REJECTION_EXIT=1", () => {
    const proc = fakeProcess({ UNHANDLED_REJECTION_EXIT: "1" });
    installProcessGuards(proc as unknown as NodeJS.Process);
    proc.emit("unhandledRejection", new Error("stray"));
    assert.equal(proc.exitCode, 1);
  });
});
