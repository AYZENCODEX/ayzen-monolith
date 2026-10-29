import { decryptRow } from "../../../lib/vault-crypto";
import { KYC_SENSITIVE_FIELDS } from "../../domain/kyc";
import { selectKycEntryForEnrollment } from "../../infrastructure/repositories/kyc-consumer-repository";

/**
 * KYC entry → project-enrollment source, extracted verbatim from
 * routes/projects.ts (VLT-GAP-03-C): the owned-row lookup and the
 * decrypt + account_data mapping used by `POST /projects/:id/enroll` when a
 * project is enrolled straight from a KYC Entity. Which enrollments already
 * exist, the PEP audit and the enrollment writes stay in the projects route.
 * The decrypted-field list is the KYC domain's own KYC_SENSITIVE_FIELDS (the
 * route used to keep a byte-identical private copy).
 */

// The caller's own KYC entry as stored (still encrypted), or null when the id
// does not exist / is not theirs.
export async function loadKycEntryForEnrollment(userId: number, kycEntryId: number): Promise<Record<string, any> | null> {
  const kycResult = await selectKycEntryForEnrollment(kycEntryId, userId);
  if (!kycResult.rows.length) return null;
  return kycResult.rows[0] as Record<string, any>;
}

// Maps a decrypted kyc_entries row onto the same account_data shape the
// manual enroll form produces (project-entities.tsx's ENROLL_EMPTY_FORM) —
// so an enrollment looks identical downstream regardless of which path
// created it.
function accountDataFromKycEntry(k: Record<string, any>): Record<string, unknown> {
  return {
    username: k.username ?? "", accountPassword: k.account_password ?? "",
    email: k.email ?? "", emailPassword: k.email_password ?? "",
    email2fa: k.email_2fa ?? "", emailBackupCode: k.email_backup_code ?? "",
    notes: k.notes ?? "",
    lastLoginAt: k.last_login_at ?? "", buyDate: k.account_buy_date ?? "", createDate: k.account_create_date ?? "",
    currentBuyValue: k.account_buy_price ?? "", currentValue: k.account_worth ?? "", followers: k.followers ?? "",
    emailRecovery: k.email_recovery ?? "", emailRecoveryPassword: k.email_recovery_password ?? "",
    recovery2fa: k.recovery_2fa ?? "", recoveryBackupCode: k.recovery_backup_code ?? "",
  };
}

export function buildEnrollmentAccountData(kycRow: Record<string, any>): Record<string, unknown> {
  const decrypted = decryptRow(kycRow, KYC_SENSITIVE_FIELDS);
  return accountDataFromKycEntry(decrypted);
}
