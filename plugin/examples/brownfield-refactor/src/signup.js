export function signup(email, password) {
  // duplicated: same regex lives in invite.js
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) throw new Error("invalid email");
  if (!password || password.length < 8) throw new Error("password too short");
  return { email, createdAt: Date.now() };
}
