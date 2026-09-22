import express from "express";
import { getUsers } from "./users.js";

const app = express();

app.get("/users", (_req, res) => {
  res.json(getUsers());
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`up on :${port}`));
}

export { app };
