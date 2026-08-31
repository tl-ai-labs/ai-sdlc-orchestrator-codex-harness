// BUG: throws unhandled TypeError when password is undefined,
// because .toLowerCase() is called on undefined. The intent is to
// validate first and return a structured 400.
export async function login(username, password) {
  const normalized = password.toLowerCase();
  if (username === "admin" && normalized === "hunter2") {
    return "tok-" + Date.now();
  }
  throw new Error("invalid credentials");
}
