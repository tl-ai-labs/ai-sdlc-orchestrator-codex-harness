import crypto from "node:crypto";
import { AppError } from "./errors.js";

const sessions = new Map();

export async function login(username, password) {
  if (!username || !password) throw new AppError("credentials required", 400);
  if (username === "admin" && password === "hunter2") {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { user: username, iat: Date.now() });
    return token;
  }
  throw new AppError("invalid credentials", 401);
}

export async function logout(token) {
  if (!token) throw new AppError("token required", 400);
  sessions.delete(token);
}

export async function verify(token) {
  if (!token) throw new AppError("token required", 401);
  const claims = sessions.get(token);
  if (!claims) throw new AppError("invalid token", 401);
  if (Date.now() - claims.iat > 3600 * 1000) {
    sessions.delete(token);
    throw new AppError("token expired", 401);
  }
  return claims;
}
