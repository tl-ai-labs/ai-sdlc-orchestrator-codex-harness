export function invite(email, inviterId) {
  // duplicated: same regex lives in signup.js
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) throw new Error("invalid email");
  return { email, inviter: inviterId, sentAt: Date.now() };
}
