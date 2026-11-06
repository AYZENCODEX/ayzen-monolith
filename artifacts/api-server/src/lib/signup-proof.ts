import { randomBytes } from "node:crypto";
import { storeOtp, verifyOtp } from "./otp-store";

/**
 * Proof that an email address was confirmed during signup.
 *
 * The 6-digit email code is single-use, but the new signup flow confirms the
 * address several screens before the account is created (username, name and
 * mail address come after). Once the code checks out, we hand the browser a
 * random single-use proof instead; /auth/register redeems it. Stored hashed
 * and expiring (10 min) through the same table as the OTPs.
 */

const key = (email: string) => `signup-proof:${email.trim().toLowerCase()}`;

export async function issueSignupProof(email: string): Promise<string> {
  const proof = randomBytes(24).toString("hex");
  await storeOtp(key(email), proof);
  return proof;
}

export async function redeemSignupProof(email: string, proof: string): Promise<boolean> {
  return verifyOtp(key(email), proof);
}
