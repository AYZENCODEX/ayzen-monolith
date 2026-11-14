import assert from "node:assert/strict";
import test from "node:test";
import {
  burnVerificationTime, checkPasswordPolicy, currentParams, hashModulePassword, hashResetToken, modulePasswordNeedsRehash, newResetToken,
  parsePhc, verifyModulePassword,
} from "./module-password";

const FAST = { memoryKib: 1024, passes: 1, parallelism: 1 };

test("hash is argon2id PHC, salted (two hashes of one password differ) and verifies", async () => {
  const a = await hashModulePassword("correct horse battery", FAST);
  const b = await hashModulePassword("correct horse battery", FAST);
  assert.match(a, /^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.notEqual(a, b);
  assert.equal(await verifyModulePassword("correct horse battery", a), true);
  assert.equal(await verifyModulePassword("correct horse batterY", a), false);
  assert.equal(await verifyModulePassword("", a), false);
  assert.equal(await verifyModulePassword("pässwörd ✓ unicode", await hashModulePassword("pässwörd ✓ unicode", FAST)), true);
});

test("verify never throws and rejects anything that is not a well-formed argon2id hash", async () => {
  for (const junk of ["", "x", "$2b$12$" + "a".repeat(53), "$argon2i$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", "$argon2id$v=18$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", "$argon2id$garbage"]) {
    assert.equal(await verifyModulePassword("anything", junk), false, junk.slice(0, 30));
  }
});

test("parsePhc bounds the cost parameters so a hostile row cannot make a login allocate gigabytes", () => {
  const base = (m: number, t: number, p: number) => `$argon2id$v=19$m=${m},t=${t},p=${p}$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA`;
  assert.ok(parsePhc(base(19456, 2, 1)));
  assert.equal(parsePhc(base(999_999_999, 2, 1)), null);
  assert.equal(parsePhc(base(262_145, 2, 1)), null);
  assert.equal(parsePhc(base(7, 2, 1)), null);
  assert.equal(parsePhc(base(19456, 0, 1)), null);
  assert.equal(parsePhc(base(19456, 11, 1)), null);
  assert.equal(parsePhc(base(19456, 2, 0)), null);
  assert.equal(parsePhc(base(19456, 2, 5)), null);
});

test("needsRehash: weaker or foreign hashes are flagged, current ones are not", async () => {
  const target = { memoryKib: 4096, passes: 2, parallelism: 1 };
  assert.equal(modulePasswordNeedsRehash(await hashModulePassword("pw-pw-pw-pw", target), target), false);
  assert.equal(modulePasswordNeedsRehash(await hashModulePassword("pw-pw-pw-pw", { ...target, memoryKib: 1024 }), target), true);
  assert.equal(modulePasswordNeedsRehash(await hashModulePassword("pw-pw-pw-pw", { ...target, passes: 1 }), target), true);
  assert.equal(modulePasswordNeedsRehash(await hashModulePassword("pw-pw-pw-pw", { ...target, memoryKib: 8192, passes: 3 }), target), false, "stronger is fine");
  assert.equal(modulePasswordNeedsRehash("$2b$12$abcdefghijklmnopqrstuv", target), true);
});

test("cost parameters come from the environment, bounded, falling back to the OWASP minimum", () => {
  assert.deepEqual(currentParams({}), { memoryKib: 19456, passes: 2, parallelism: 1 });
  assert.deepEqual(currentParams({ MODULE_ARGON2_MEMORY_KIB: "65536", MODULE_ARGON2_PASSES: "3" }), { memoryKib: 65536, passes: 3, parallelism: 1 });
  assert.deepEqual(currentParams({ MODULE_ARGON2_MEMORY_KIB: "9999999999", MODULE_ARGON2_PASSES: "-1" }), { memoryKib: 19456, passes: 2, parallelism: 1 });
  assert.deepEqual(currentParams({ MODULE_ARGON2_MEMORY_KIB: "lots", MODULE_ARGON2_PASSES: "2.5" }), { memoryKib: 19456, passes: 2, parallelism: 1 });
});

test("burnVerificationTime resolves without throwing and costs about a real verification", async () => {
  const real = await hashModulePassword("a-real-password", currentParams());
  const t0 = process.hrtime.bigint(); await verifyModulePassword("a-real-password", real); const realMs = Number(process.hrtime.bigint() - t0) / 1e6;
  await burnVerificationTime("warm-up"); // first call also builds the dummy hash
  const t1 = process.hrtime.bigint(); await burnVerificationTime("whatever"); const burnMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(burnMs > realMs / 4 && burnMs < realMs * 4 + 50, `burn ${burnMs.toFixed(1)}ms vs real ${realMs.toFixed(1)}ms`);
});

test("password policy", () => {
  const id = "person@example.test";
  const code = (p: unknown) => { const r = checkPasswordPolicy(p, id); return r.ok ? "ok" : r.code; };
  assert.equal(code("short"), "PASSWORD_TOO_SHORT");
  assert.equal(code(undefined), "PASSWORD_TOO_SHORT");
  assert.equal(code(12345678901), "PASSWORD_TOO_SHORT");
  assert.equal(code("x".repeat(129)), "PASSWORD_TOO_LONG");
  assert.equal(code("x".repeat(128 )), "PASSWORD_TOO_SIMPLE");
  assert.equal(code("abababababab"), "PASSWORD_TOO_SIMPLE");
  assert.equal(code("PERSON@example.test"), "PASSWORD_EQUALS_IDENTIFIER");
  assert.equal(code("a decent passphrase"), "ok", "spaces and no composition rules");
  assert.equal(code("0123456789"), "ok");
});

test("reset tokens: 256-bit, unique, only the sha256 is kept", () => {
  const a = newResetToken(), b = newResetToken();
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 43, "32 bytes base64url");
  assert.match(a.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(hashResetToken(a.token), a.tokenHash);
  assert.notEqual(a.tokenHash, a.token);
  assert.notEqual(hashResetToken(a.token + "x"), a.tokenHash);
});
