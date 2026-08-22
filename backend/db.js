const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const DB_HOST = process.env.DB_HOST || '157.245.207.91';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || 'admin_user';
const DB_PASS = process.env.DB_PASS || 'Admin@Secure123!';
const DB_NAME = process.env.DB_NAME || 'ai_cctv';

const ENROLLMENT_ROOT = path.join(__dirname, '..', 'face-ai', 'enrollments');

const DEFAULT_FEATURES = [
  { name: 'fire_detection', enabled: 1, description: 'Log fire/smoke incidents detected by the AI worker' },
  { name: 'face_detection', enabled: 1, description: 'Log recognized face matches as incidents' },
  { name: 'person_detection', enabled: 0, description: 'Log person presence (high volume — off by default)' },
  { name: 'loitering_detection', enabled: 1, description: 'Log persons that dwell in-frame beyond LOITERING_SECONDS (default 30s)' },
  { name: 'plate_detection', enabled: 1, description: 'Log recognized Bangla / English license plates from vehicles in view' },
  { name: 'bag_counting', enabled: 1, description: 'Count conveyor bags crossing a camera\'s counting line (per-camera line required)' },
];

let pool;

async function init() {
  // Bootstrap: create db if missing
  const bootstrap = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
  });
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();

  pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME,
    waitForConnections: true, connectionLimit: 10, queueLimit: 0,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // ── features: now per-user (user_id, name) unique ────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL DEFAULT 0,
      name VARCHAR(64) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      description VARCHAR(255),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_feature (user_id, name)
    ) ENGINE=InnoDB
  `);
  await ensureColumn('features', 'user_id', 'INT NOT NULL DEFAULT 0');
  await dropIndexIfExists('features', 'name');
  await ensureUniqueIndex('features', 'uniq_user_feature', ['user_id', 'name']);
  await migrateGlobalFeatures();

  // ── cameras: persistent, owned by a user ─────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cameras (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      stream_id VARCHAR(64) NOT NULL UNIQUE,
      camera_name VARCHAR(255) NOT NULL,
      rtsp_url TEXT NOT NULL,
      path_name VARCHAR(128) NOT NULL,
      lat DECIMAL(10, 7) NULL,
      lng DECIMAL(10, 7) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB
  `);
  // Backfill the columns on installs that were created before lat/lng existed.
  await ensureColumn('cameras', 'lat', 'DECIMAL(10, 7) NULL');
  await ensureColumn('cameras', 'lng', 'DECIMAL(10, 7) NULL');
  // Bag counting is opt-in per camera: NULL here means "not a conveyor camera"
  // and the AI worker skips the pipeline entirely for that stream.
  await ensureColumn('cameras', 'bag_line_json', 'TEXT NULL');
  // "Reset counter" is non-destructive — it stamps a cutoff instead of deleting
  // buckets, so throughput history survives a reset.
  await ensureColumn('cameras', 'bag_reset_at', 'DATETIME NULL');

  // ── bag_counts: conveyor throughput, aggregated per minute ─
  // One row per (stream, minute) rather than per bag: a busy belt does
  // thousands of bags an hour, and per-minute buckets are what the throughput
  // chart actually needs. The cumulative total is SUM(count) over the buckets
  // after the camera's bag_reset_at, so it survives a backend restart.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bag_counts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      stream_id VARCHAR(64) NOT NULL,
      bucket_minute DATETIME NOT NULL,
      count INT NOT NULL DEFAULT 0,
      UNIQUE KEY uniq_stream_bucket (stream_id, bucket_minute),
      INDEX idx_user (user_id),
      INDEX idx_bucket (bucket_minute)
    ) ENGINE=InnoDB
  `);

  // ── enrollments: per-person metadata (type, notes) ────────
  // The actual face images live on disk in face-ai/enrollments/<user_id>/.
  // This table tracks the categorization (threat/vip/staff/...) and any notes
  // so the dashboard and AI worker can color-code recognized faces.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enrollments (
      id          INT          NOT NULL AUTO_INCREMENT,
      user_id     INT          NOT NULL,
      name        VARCHAR(255) NOT NULL,
      type        VARCHAR(32)  NOT NULL DEFAULT 'standard',
      notes       VARCHAR(500),
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_enroll (user_id, name),
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB
  `);

  // ── incidents: owned by user_id ───────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL DEFAULT 0,
      stream_id VARCHAR(64) NOT NULL,
      camera_name VARCHAR(255),
      type VARCHAR(32) NOT NULL,
      name VARCHAR(255) NULL,
      confidence FLOAT,
      bbox_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_stream (stream_id),
      INDEX idx_type (type),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB
  `);
  await ensureColumn('incidents', 'user_id', 'INT NOT NULL DEFAULT 0');
  await ensureColumn('incidents', 'snapshot_path', 'VARCHAR(255) NULL');

  await seedAdmin();
  await migrateLegacyEnrollments();
  await backfillFeaturesForAllUsers();
}

// Seed every default feature row (see DEFAULT_FEATURES) for every existing user.
// Idempotent — the INSERT uses ON DUPLICATE KEY UPDATE, so users who already
// have a row for the feature just get their description refreshed. Runs on every
// backend boot so newly-added default features roll out to existing accounts
// without a manual migration step.
async function backfillFeaturesForAllUsers() {
  const [users] = await pool.query('SELECT id FROM users');
  if (!users.length) return;
  for (const u of users) {
    await seedFeaturesFor(u.id);
  }
  console.log(`[DB] Backfilled default features for ${users.length} user(s)`);
}

async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, table, column],
  );
  if (rows[0].c === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function dropIndexIfExists(table, indexName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [DB_NAME, table, indexName],
  );
  if (rows[0].c > 0) {
    await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``);
  }
}

async function ensureUniqueIndex(table, indexName, columns) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [DB_NAME, table, indexName],
  );
  if (rows[0].c === 0) {
    const cols = columns.map((c) => `\`${c}\``).join(', ');
    await pool.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${indexName}\` (${cols})`);
  }
}

// One-time migration from the previous global features table (no user_id) to per-user.
// Tolerates a fresh install (no rows) and an already-migrated install (all rows have user_id).
async function migrateGlobalFeatures() {
  const [orphans] = await pool.query('SELECT id FROM features WHERE user_id = 0 LIMIT 1');
  if (orphans.length === 0) return;
  const [admins] = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  const adminId = admins[0]?.id;
  if (!adminId) {
    // No users yet — drop orphans; seedFeaturesFor() will recreate properly when admin is created.
    await pool.query('DELETE FROM features WHERE user_id = 0');
    return;
  }
  await pool.query('UPDATE features SET user_id = ? WHERE user_id = 0', [adminId]);
}

async function seedAdmin() {
  const [rows] = await pool.query('SELECT id FROM users');
  if (rows.length > 0) {
    // Make sure the existing admin has features and enrollment dir.
    const adminId = rows[0].id;
    await seedFeaturesFor(adminId);
    ensureUserDir(adminId);
    return;
  }
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASS || 'admin123';
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
  await seedFeaturesFor(result.insertId);
  ensureUserDir(result.insertId);
  console.log(`[DB] Seeded admin user "${username}"`);
}

async function seedFeaturesFor(userId) {
  for (const f of DEFAULT_FEATURES) {
    await pool.query(
      `INSERT INTO features (user_id, name, enabled, description)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description)`,
      [userId, f.name, f.enabled, f.description],
    );
  }
}

function userEnrollmentDir(userId) {
  return path.join(ENROLLMENT_ROOT, String(userId));
}

function ensureUserDir(userId) {
  fs.mkdirSync(userEnrollmentDir(userId), { recursive: true });
}

// Move any *.{jpg,jpeg,png} sitting at the root of enrollments/ into user 1's dir,
// so legacy single-tenant data continues to work after migration.
async function migrateLegacyEnrollments() {
  if (!fs.existsSync(ENROLLMENT_ROOT)) return;
  const [admins] = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  const adminId = admins[0]?.id;
  if (!adminId) return;
  const adminDir = userEnrollmentDir(adminId);
  fs.mkdirSync(adminDir, { recursive: true });
  for (const f of fs.readdirSync(ENROLLMENT_ROOT)) {
    if (!/\.(jpg|jpeg|png)$/i.test(f)) continue;
    const from = path.join(ENROLLMENT_ROOT, f);
    if (!fs.statSync(from).isFile()) continue;
    const to = path.join(adminDir, f);
    if (fs.existsSync(to)) continue;
    fs.renameSync(from, to);
    console.log(`[DB] Migrated legacy enrollment ${f} -> user ${adminId}`);
  }
  // Bump mtime so worker picks it up
  fs.utimesSync(adminDir, new Date(), new Date());
}

async function createUser(username, password) {
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, hash],
  );
  await seedFeaturesFor(result.insertId);
  ensureUserDir(result.insertId);
  return { id: result.insertId, username };
}

function getPool() {
  if (!pool) throw new Error('DB pool not initialized — call init() first');
  return pool;
}

module.exports = { init, getPool, createUser, seedFeaturesFor, userEnrollmentDir, ensureUserDir };
