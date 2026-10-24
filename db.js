const { Pool } = require("pg");
require("dotenv").config();

// Support both DATABASE_URL (single string) and individual DB_* vars (Render dashboard style)
function buildConfig() {
  if (process.env.DATABASE_URL) {
    const connectionString = process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, "");
    return { connectionString, ssl: { rejectUnauthorized: false } };
  }
  return {
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  };
}

const pool = new Pool({
  ...buildConfig(),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("Uventet DB-feil:", err.message);
});

module.exports = pool;
