import express from "express";
import { loadConfig } from "./config.js";

const cfg = loadConfig({ server: { port: Number(process.env.PORT ?? 3000) } });
const app = express();
app.get("/", (_req, res) => res.json({ ok: true, cfg }));

if (process.env.NODE_ENV !== "test") {
  app.listen(cfg.server.port, cfg.server.host, () =>
    console.log(`up on ${cfg.server.host}:${cfg.server.port}`)
  );
}
export { app, cfg };
