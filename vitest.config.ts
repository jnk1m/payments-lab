import { defineConfig } from "vitest/config";

// Tests share one PostgreSQL database, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false } });
