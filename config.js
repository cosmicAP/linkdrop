// Runtime settings. Everything the app needs from its environment is read here.
module.exports = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 8080,
  databaseUrl: process.env.DATABASE_URL,
  pageSize: 20,
};
