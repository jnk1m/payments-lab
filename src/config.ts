function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}. Copy .env.example to .env.`);
  return value;
}

export const config = {
  clientKey: () => required("TOSS_CLIENT_KEY"),
  secretKey: () => required("TOSS_SECRET_KEY"),
  apiBase: () => process.env.TOSS_API_BASE ?? "https://api.tosspayments.com",
  databaseUrl: () => required("DATABASE_URL"),
  port: () => Number(process.env.PORT ?? 3000),
};

// Fixed product so the amount always comes from the server.
export const PRODUCT = { orderName: "Test coffee beans", amount: 15000 };
