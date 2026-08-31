const accounts = new Map([
  ["acct-1", { balance: 100_00 }],  // cents
  ["acct-2", { balance: 500_00 }],
]);
const refunds = new Set();

export function getAccount(id) {
  const a = accounts.get(id);
  if (!a) throw new Error("unknown account: " + id);
  return a;
}

export function markRefunded(ref) {
  const already = refunds.has(ref);
  refunds.add(ref);
  return !already;   // true = first time
}
