import express from "express";
import { login } from "./auth.js";

const app = express();
app.use(express.json());

app.post("/login", async (req, res) => {
  try {
    const token = await login(req.body?.username, req.body?.password);
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: "internal error" });
  }
});

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`up on :${port}`));
}

export { app };
