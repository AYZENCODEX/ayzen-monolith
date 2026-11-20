/**
 * Test-only stand-in for @simplewebauthn/server. It does NOT do the signature maths (the real library does, see routes/passkey.ts);
 * it still checks challenge, origin, ceremony type and credential id, so the challenge binding, limits, counter and session logic
 * of module-auth-v2-service are exercised without the package. Never imported by production code.
 */
import { randomBytes } from "node:crypto";
const b64u = (x: Uint8Array | Buffer) => Buffer.from(x).toString("base64url");
export const FAKE_WA = {
  generateRegistrationOptions: async (o: any) => ({ challenge: randomBytes(16).toString("base64url"), rp: { name: o.rpName, id: o.rpID }, user: { id: b64u(o.userID), name: o.userName, displayName: o.userDisplayName },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: o.excludeCredentials.map((c: any) => ({ id: c.id, type: "public-key" })), attestation: "none", timeout: 60000 }),
  verifyRegistrationResponse: async (o: any) => { const cd = JSON.parse(Buffer.from(o.response.response.clientDataJSON, "base64url").toString());
    if (cd.type !== "webauthn.create" || cd.challenge !== o.expectedChallenge || cd.origin !== o.expectedOrigin) throw new Error("bad registration");
    return { verified: true, registrationInfo: { credential: { id: o.response.id, publicKey: new Uint8Array(Buffer.from(o.response.response.attestationObject, "base64url")), counter: 0, transports: ["internal"] }, credentialDeviceType: "multiDevice", credentialBackedUp: true } }; },
  generateAuthenticationOptions: async (o: any) => ({ challenge: randomBytes(16).toString("base64url"), rpId: o.rpID, allowCredentials: o.allowCredentials.map((c: any) => ({ id: c.id, type: "public-key", transports: c.transports })), userVerification: "preferred", timeout: 60000 }),
  verifyAuthenticationResponse: async (o: any) => { const cd = JSON.parse(Buffer.from(o.response.response.clientDataJSON, "base64url").toString());
    if (cd.type !== "webauthn.get" || cd.challenge !== o.expectedChallenge || cd.origin !== o.expectedOrigin || o.response.id !== o.credential.id) throw new Error("bad assertion");
    return { verified: true, authenticationInfo: { newCounter: o.credential.counter + 1 } }; },
};
