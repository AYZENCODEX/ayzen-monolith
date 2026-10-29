import QRCode from "qrcode";
import { db, financePaymentMethodsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bkash: "bKash",
  nagad: "Nagad",
  rocket: "Rocket",
  bank: "Bank Transfer",
  usdt: "USDT",
};

type PaymentMethodQrInput = Pick<
  typeof financePaymentMethodsTable.$inferSelect,
  "methodType" | "label" | "accountNumber" | "bankAccountNumber" | "usdtAddress"
>;

function qrPayload(method: PaymentMethodQrInput): string | null {
  switch (method.methodType) {
    case "bkash":
    case "nagad":
    case "rocket":
      return method.accountNumber
        ? `${PAYMENT_METHOD_LABELS[method.methodType]}\nSend to: ${method.accountNumber}${method.label ? `\n(${method.label})` : ""}`
        : null;
    case "bank":
      return method.bankAccountNumber ?? null;
    case "usdt":
      return method.usdtAddress ?? null;
    default:
      return null;
  }
}

/** QR failures are non-fatal so a public repayment page remains available. */
export async function generatePaymentQrDataUrl(method: PaymentMethodQrInput): Promise<string | null> {
  const payload = qrPayload(method);
  if (!payload) return null;
  try {
    return await QRCode.toDataURL(payload, { margin: 1, width: 240 });
  } catch {
    return null;
  }
}

export interface PublicPaymentMethod {
  id: number;
  methodType: string;
  label: string | null;
  accountNumber: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
  usdtAddress: string | null;
  usdtNetwork: string | null;
  isDefault: boolean;
  qrDataUrl: string | null;
}

export async function listActivePaymentMethods(userId: number): Promise<PublicPaymentMethod[]> {
  const rows = await db.select().from(financePaymentMethodsTable)
    .where(eq(financePaymentMethodsTable.userId, userId));
  return Promise.all(rows.filter((row) => row.active === 1).map(async (row) => ({
    id: row.id,
    methodType: row.methodType,
    label: row.label,
    accountNumber: row.accountNumber,
    bankName: row.bankName,
    bankAccountName: row.bankAccountName,
    bankAccountNumber: row.bankAccountNumber,
    bankRoutingNumber: row.bankRoutingNumber,
    usdtAddress: row.usdtAddress,
    usdtNetwork: row.usdtNetwork,
    isDefault: row.isDefault === 1,
    qrDataUrl: await generatePaymentQrDataUrl(row),
  })));
}

export async function listFinancePaymentMethods(userId: number) {
  return db.select().from(financePaymentMethodsTable)
    .where(eq(financePaymentMethodsTable.userId, userId))
    .orderBy(desc(financePaymentMethodsTable.isDefault), desc(financePaymentMethodsTable.createdAt));
}

export async function resetFinancePaymentMethodDefaults(userId: number): Promise<void> {
  await db.update(financePaymentMethodsTable)
    .set({ isDefault: 0 })
    .where(eq(financePaymentMethodsTable.userId, userId));
}

export async function createFinancePaymentMethod(
  userId: number,
  body: Record<string, any>,
) {
  if (body.isDefault) await resetFinancePaymentMethodDefaults(userId);
  const [row] = await db.insert(financePaymentMethodsTable).values({
    userId,
    methodType: body.methodType,
    label: body.label ?? null,
    accountNumber: body.accountNumber ?? null,
    bankName: body.bankName ?? null,
    bankAccountName: body.bankAccountName ?? null,
    bankAccountNumber: body.bankAccountNumber ?? null,
    bankRoutingNumber: body.bankRoutingNumber ?? null,
    usdtAddress: body.usdtAddress ?? null,
    usdtNetwork: body.usdtNetwork ?? "TRC20",
    isDefault: body.isDefault ? 1 : 0,
    active: 1,
  }).returning();
  return row;
}

export async function updateFinancePaymentMethod(
  userId: number,
  id: number,
  body: Record<string, any>,
) {
  const { id: _id, userId: _uid, createdAt: _ca, ...patch } = body;
  const [row] = await db.update(financePaymentMethodsTable)
    .set({
      ...patch,
      isDefault: body.isDefault ? 1 : (body.isDefault === false ? 0 : undefined),
      updatedAt: new Date(),
    })
    .where(and(
      eq(financePaymentMethodsTable.id, id),
      eq(financePaymentMethodsTable.userId, userId),
    ))
    .returning();
  return row;
}

export async function deleteFinancePaymentMethod(userId: number, id: number): Promise<boolean> {
  const deleted = await db.delete(financePaymentMethodsTable)
    .where(and(
      eq(financePaymentMethodsTable.id, id),
      eq(financePaymentMethodsTable.userId, userId),
    ))
    .returning();
  return deleted.length > 0;
}
