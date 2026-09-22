import express from "express";
import { login, logout, verify } from "./auth.js";
import { AppError } from "./errors.js";

const app = express();
app.use(express.json());

app.post("/auth/login", async (req, res, next) => {
  try {
    const token = await login(req.body?.username, req.body?.password);
    res.json({ token });
  } catch (e) { next(e); }
});

app.post("/auth/logout", async (req, res, next) => {
  try {
    await logout(req.body?.token);
    res.status(204).end();
  } catch (e) { next(e); }
});

app.get("/auth/verify", async (req, res, next) => {
  try {
    const claims = await verify(req.headers.authorization?.slice("Bearer ".length));
    res.json(claims);
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: "internal error" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`up on :${port}`));
