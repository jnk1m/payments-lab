import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { createDb } from "./db.js";

process.loadEnvFile();
serve({ fetch: createApp(createDb()).fetch, port: config.port() }, (info) =>
  console.log(`http://localhost:${info.port}`),
);
