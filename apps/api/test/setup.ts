/**
 * Test environment defaults.
 *
 * Integration tests run against a real PostgreSQL + PostGIS database. There is
 * no mocking layer: the behavior under test — row-level locking semantics under
 * concurrent conditional UPDATEs — exists only in the database, so a mock would
 * prove nothing at all.
 */
process.env.NODE_ENV ??= 'test'
process.env.DATABASE_URL ??= 'postgresql://grass:grass@localhost:5432/grassassassin_dev'
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-characters-long'
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long'
