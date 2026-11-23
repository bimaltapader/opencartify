const expected = {
  host: '127.0.0.1',
  port: '55433',
  username: 'opencartify_inventory_test',
  database: 'opencartify_inventory_integration_test',
};

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('Integration tests require DATABASE_URL.');
}

let parsed: URL;

try {
  parsed = new URL(databaseUrl);
} catch {
  throw new Error('Integration tests received an invalid DATABASE_URL.');
}

if (
  parsed.protocol !== 'postgresql:' ||
  parsed.hostname !== expected.host ||
  parsed.port !== expected.port ||
  parsed.username !== expected.username ||
  parsed.pathname !== `/${expected.database}`
) {
  throw new Error('Integration tests refused a non-isolated database target.');
}
