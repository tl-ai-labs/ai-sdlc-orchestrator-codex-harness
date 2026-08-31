import { getAccount, markRefunded } from "./db.js";

export function charge(accountId, amountCents) {
  if (typeof amountCents !== "number" || amountCents <= 0) throw new Error("invalid amount");
  const a = getAccount(accountId);
  if (a.balance < amountCents) throw new Error("insufficient funds");
  a.balance -= amountCents;
  return { accountId, chargedCents: amountCents, newBalance: a.balance };
}

export function refund(accountId, amountCents, ref) {
  if (typeof amountCents !== "number" || amountCents <= 0) throw new Error("invalid amount");
  if (!ref) throw new Error("refund ref required");
  const a = getAccount(accountId);
  const first = markRefunded(ref);
  if (!first) return { accountId, refundedCents: 0, newBalance: a.balance, note: "already refunded" };
  a.balance += amountCents;
  return { accountId, refundedCents: amountCents, newBalance: a.balance };
}

export function getBalance(accountId) {
  return getAccount(accountId).balance;
}
