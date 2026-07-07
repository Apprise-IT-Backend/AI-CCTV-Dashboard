-- AI-CCTV Dashboard schema + seed data.
-- Self-contained: a single `mysql -u root < schema.sql` provisions an empty
-- DB into a fully working app — admin + demo users created, default feature
-- toggles set, and ~120 sample incidents per dashboard.
--
-- Idempotent:
--   - Schema uses CREATE TABLE IF NOT EXISTS, won't clobber an existing DB.
--   - Users use INSERT IGNORE — re-running won't fail or create duplicates.
--   - Features use INSERT IGNORE on (user_id, name).
--   - Sample incidents only seed when no incidents exist for users 1/2/3
--     (guarded by a stored procedure that drops itself after running).
--
-- Default credentials seeded:
--   admin / admin123     (id 1)
--   demo  / demopass1    (id 2)
--   alice / alicepass1   (id 3)

CREATE DATABASE IF NOT EXISTS `ai_cctv`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `ai_cctv`;

-- ── users ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INT          NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- ── features ────────────────────────────────────────────────────────────
-- Per-user detection toggles. Composite unique on (user_id, name) lets the
-- same feature key exist independently per user.
CREATE TABLE IF NOT EXISTS features (
  id          INT          NOT NULL AUTO_INCREMENT,
  user_id     INT          NOT NULL DEFAULT 0,
  name        VARCHAR(64)  NOT NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  description VARCHAR(255),
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_feature (user_id, name)
) ENGINE=InnoDB;

-- ── cameras ─────────────────────────────────────────────────────────────
-- Persistent camera registry. server.js#bootstrapCamerasFromDb re-creates
-- the MediaMTX path, agent process, and AI worker thread for each row on
-- backend startup, so cameras survive restarts.
CREATE TABLE IF NOT EXISTS cameras (
  id          INT             NOT NULL AUTO_INCREMENT,
  user_id     INT             NOT NULL,
  stream_id   VARCHAR(64)     NOT NULL UNIQUE,
  camera_name VARCHAR(255)    NOT NULL,
  rtsp_url    TEXT            NOT NULL,
  path_name   VARCHAR(128)    NOT NULL,
  lat         DECIMAL(10, 7)  NULL,
  lng         DECIMAL(10, 7)  NULL,
  created_at  TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_user (user_id)
) ENGINE=InnoDB;

-- ── enrollments ─────────────────────────────────────────────────────────
-- Per-person metadata. The actual face images live on disk in
-- face-ai/enrollments/<user_id>/<name>_<idx>.{jpg,png}; this table tracks
-- categorization (threat/vip/staff/visitor/standard) and free-form notes.
-- Composite unique on (user_id, name) so the same name can exist under
-- different accounts independently.
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
) ENGINE=InnoDB;

-- ── incidents ───────────────────────────────────────────────────────────
-- Detection log. Written by server.js#persistIncidents() with a per
-- (stream_id, type, name) throttle so a steady fire doesn't flood the table.
--   type        = 'face' | 'person' | 'fire' | 'smoke'
--   name        = recognized identity (face only) or NULL
--   confidence  = 0.0–1.0
--   bbox_json   = {"x":...,"y":...,"w":...,"h":...} relative coords
CREATE TABLE IF NOT EXISTS incidents (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  user_id       INT          NOT NULL DEFAULT 0,
  stream_id     VARCHAR(64)  NOT NULL,
  camera_name   VARCHAR(255),
  type          VARCHAR(32)  NOT NULL,
  name          VARCHAR(255) NULL,
  confidence    FLOAT,
  bbox_json     TEXT,
  snapshot_path VARCHAR(255) NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_user    (user_id),
  INDEX idx_stream  (stream_id),
  INDEX idx_type    (type),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;


-- ════════════════════════════════════════════════════════════════════════
-- SEED DATA
-- ════════════════════════════════════════════════════════════════════════

-- ── users (bcrypt cost-10 hashes precomputed) ───────────────────────────
-- Plaintext passwords, for reference only (do NOT store these anywhere):
--   admin → admin123
--   demo  → demopass1
--   alice → alicepass1
INSERT IGNORE INTO users (id, username, password_hash) VALUES
  (1, 'admin', '$2b$10$UzczzvOTmuSW4aQFgR09R.oECM5u2hU8xjXk8qwA.wOgs8RlK8FH2'),
  (2, 'demo',  '$2b$10$KC1ni.bKyPo5S/fAMM8nYOaVIU0HtUHZ3wbmd/Egzry2dS6U.pKw6'),
  (3, 'alice', '$2b$10$UcqmPlg5sm2rb.5n6juKbetXYtvsZwN.5sf7MqWq.vhAU8Fp5gOCq');

-- ── default detection features per user ─────────────────────────────────
INSERT IGNORE INTO features (user_id, name, enabled, description) VALUES
  (1, 'fire_detection',       1, 'Log fire/smoke incidents detected by the AI worker'),
  (1, 'face_detection',       1, 'Log recognized face matches as incidents'),
  (1, 'person_detection',     0, 'Log person presence (high volume — off by default)'),
  (1, 'loitering_detection',  1, 'Log persons that dwell in-frame beyond LOITERING_SECONDS (default 30s)'),
  (1, 'plate_detection',      1, 'Log recognized Bangla / English license plates from vehicles in view'),
  (2, 'fire_detection',       1, 'Log fire/smoke incidents detected by the AI worker'),
  (2, 'face_detection',       1, 'Log recognized face matches as incidents'),
  (2, 'person_detection',     0, 'Log person presence (high volume — off by default)'),
  (2, 'loitering_detection',  1, 'Log persons that dwell in-frame beyond LOITERING_SECONDS (default 30s)'),
  (2, 'plate_detection',      1, 'Log recognized Bangla / English license plates from vehicles in view'),
  (3, 'fire_detection',       1, 'Log fire/smoke incidents detected by the AI worker'),
  (3, 'face_detection',       1, 'Log recognized face matches as incidents'),
  (3, 'person_detection',     0, 'Log person presence (high volume — off by default)'),
  (3, 'loitering_detection',  1, 'Log persons that dwell in-frame beyond LOITERING_SECONDS (default 30s)'),
  (3, 'plate_detection',      1, 'Log recognized Bangla / English license plates from vehicles in view');

-- ── sample cameras (around Badda, Dhaka — across all 3 seeded users) ────
-- Decorative only: the RTSP host `demo.local` doesn't resolve, so the
-- backend bootstrap recognizes the prefix and skips spawning a real
-- agent/AI/MediaMTX path. They show up on the Maps page so the demo isn't
-- empty on a fresh install. Each user gets their own cluster of cameras
-- with realistic names; the Map zoom fits all of them in the Badda area.
INSERT IGNORE INTO cameras (user_id, stream_id, camera_name, rtsp_url, path_name, lat, lng) VALUES
  -- admin (id=1)
  (1, 'seed-cam-admin-main', 'Main Entrance',    'rtsp://demo.local:554/main', 'camera_seed_admin_1', 23.7805, 90.4252),
  (1, 'seed-cam-admin-park', 'Parking Lot',      'rtsp://demo.local:554/park', 'camera_seed_admin_2', 23.7818, 90.4203),
  (1, 'seed-cam-admin-recp', 'Reception',        'rtsp://demo.local:554/recp', 'camera_seed_admin_3', 23.7864, 90.4258),
  (1, 'seed-cam-admin-stor', 'Storage Room',     'rtsp://demo.local:554/stor', 'camera_seed_admin_4', 23.7710, 90.4163),
  -- demo (id=2)
  (2, 'seed-cam-badda',      'Badda DIT Project','rtsp://demo.local:554/badda',     'camera_seed_demo_1',  23.7806, 90.4255),
  (2, 'seed-cam-gulshan1',   'Gulshan-1 Circle', 'rtsp://demo.local:554/gulshan1',  'camera_seed_demo_2',  23.7806, 90.4193),
  (2, 'seed-cam-gulshan2',   'Gulshan-2 Circle', 'rtsp://demo.local:554/gulshan2',  'camera_seed_demo_3',  23.7937, 90.4148),
  (2, 'seed-cam-notunbzar',  'Notun Bazar',      'rtsp://demo.local:554/notunbzar', 'camera_seed_demo_4',  23.7889, 90.4260),
  (2, 'seed-cam-rampura',    'Rampura',          'rtsp://demo.local:554/rampura',   'camera_seed_demo_5',  23.7635, 90.4197),
  (2, 'seed-cam-aftabnagar', 'Aftabnagar',       'rtsp://demo.local:554/aftabnagar','camera_seed_demo_6',  23.7702, 90.4476),
  -- alice (id=3)
  (3, 'seed-cam-alice-off',  'Office Front',     'rtsp://demo.local:554/off',  'camera_seed_alice_1', 23.7748, 90.4185),
  (3, 'seed-cam-alice-hall', 'Hallway',          'rtsp://demo.local:554/hall', 'camera_seed_alice_2', 23.7902, 90.4318),
  (3, 'seed-cam-alice-srv',  'Server Room',      'rtsp://demo.local:554/srv',  'camera_seed_alice_3', 23.7775, 90.4395),
  (3, 'seed-cam-alice-bk',   'Back Door',        'rtsp://demo.local:554/bk',   'camera_seed_alice_4', 23.7682, 90.4283);

-- ── sample enrollments (recognized people referenced by face detections) ─
INSERT IGNORE INTO enrollments (user_id, name, type) VALUES
  (1, 'Ankon', 'staff'),
  (1, 'Jane',  'visitor'),
  (1, 'Tonoy', 'standard'),
  (2, 'Ankon', 'vip'),
  (2, 'Jane',  'staff'),
  (2, 'Tonoy', 'standard'),
  (3, 'Ankon', 'standard'),
  (3, 'Jane',  'staff'),
  (3, 'Tonoy', 'threat');

-- ── sample incidents ────────────────────────────────────────────────────
-- Wrapped in a one-shot procedure so re-running the file is safe — only
-- inserts if users 1/2/3 currently have zero incidents.
DELIMITER $$
DROP PROCEDURE IF EXISTS seed_sample_incidents$$
CREATE PROCEDURE seed_sample_incidents()
BEGIN
  IF (SELECT COUNT(*) FROM incidents WHERE user_id IN (1, 2, 3)) = 0 THEN
    INSERT INTO incidents (user_id, stream_id, camera_name, type, name, confidence, bbox_json, created_at) VALUES
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', NULL, 0.69, '{"x":0.254,"y":0.346,"w":0.37,"h":0.298}', '2026-05-03 06:18:03'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Ankon', 0.86, '{"x":0.549,"y":0.452,"w":0.169,"h":0.356}', '2026-05-06 07:25:28'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.66, '{"x":0.917,"y":0.03,"w":0.101,"h":0.259}', '2026-04-26 09:34:40'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.62, '{"x":0.364,"y":0.101,"w":0.386,"h":0.259}', '2026-05-10 10:33:37'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.93, '{"x":0.463,"y":0.398,"w":0.289,"h":0.225}', '2026-04-22 05:34:15'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.94, '{"x":0.828,"y":0.432,"w":0.241,"h":0.219}', '2026-05-08 10:08:35'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.88, '{"x":0.844,"y":0.482,"w":0.116,"h":0.269}', '2026-05-09 14:56:04'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', NULL, 0.80, '{"x":0.029,"y":0.465,"w":0.261,"h":0.112}', '2026-05-07 05:06:54'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Jane', 0.86, '{"x":0.169,"y":0.144,"w":0.123,"h":0.348}', '2026-04-29 18:54:14'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.89, '{"x":0.893,"y":0.487,"w":0.104,"h":0.321}', '2026-04-19 19:08:50'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.91, '{"x":0.103,"y":0.353,"w":0.102,"h":0.213}', '2026-04-18 05:50:08'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'person', NULL, 0.77, '{"x":0.319,"y":0.124,"w":0.262,"h":0.298}', '2026-04-14 15:57:40'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', NULL, 0.70, '{"x":0.733,"y":0.421,"w":0.353,"h":0.258}', '2026-04-15 20:58:32'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Jane', 0.82, '{"x":0.304,"y":0.437,"w":0.262,"h":0.17}', '2026-04-16 22:43:52'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Tonoy', 0.86, '{"x":0.241,"y":0.441,"w":0.285,"h":0.141}', '2026-05-10 09:56:11'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.90, '{"x":0.499,"y":0.035,"w":0.384,"h":0.368}', '2026-04-18 11:52:30'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.94, '{"x":0.994,"y":0.379,"w":0.374,"h":0.386}', '2026-05-04 06:01:29'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.74, '{"x":0.873,"y":0.386,"w":0.378,"h":0.102}', '2026-04-22 11:28:13'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.98, '{"x":0.353,"y":0.211,"w":0.292,"h":0.379}', '2026-04-10 16:52:37'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Ankon', 0.85, '{"x":0.002,"y":0.437,"w":0.235,"h":0.389}', '2026-05-08 06:42:31'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.77, '{"x":0.595,"y":0.071,"w":0.286,"h":0.372}', '2026-04-19 17:19:31'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.94, '{"x":0.849,"y":0.155,"w":0.277,"h":0.252}', '2026-04-28 13:23:18'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Tonoy', 0.91, '{"x":0.27,"y":0.263,"w":0.249,"h":0.248}', '2026-05-04 15:04:57'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'person', NULL, 0.61, '{"x":0.762,"y":0.157,"w":0.29,"h":0.274}', '2026-04-25 12:47:15'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', NULL, 0.61, '{"x":0.777,"y":0.32,"w":0.385,"h":0.14}', '2026-05-01 06:59:27'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'person', NULL, 0.64, '{"x":0.6,"y":0.053,"w":0.216,"h":0.184}', '2026-05-02 23:45:05'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Jane', 0.74, '{"x":0.969,"y":0.108,"w":0.296,"h":0.148}', '2026-05-06 14:13:26'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', 'Tonoy', 0.83, '{"x":0.723,"y":0.045,"w":0.273,"h":0.384}', '2026-05-10 06:22:44'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'fire', NULL, 0.65, '{"x":0.176,"y":0.121,"w":0.353,"h":0.38}', '2026-05-01 14:02:29'),
      (1, 'seed-cam-admin-recp', 'Reception', 'smoke', NULL, 0.60, '{"x":0.716,"y":0.298,"w":0.339,"h":0.293}', '2026-05-06 05:03:55'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'smoke', NULL, 0.92, '{"x":0.53,"y":0.221,"w":0.207,"h":0.178}', '2026-04-22 00:17:15'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', NULL, 0.79, '{"x":0.959,"y":0.219,"w":0.262,"h":0.362}', '2026-05-02 09:20:04'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.92, '{"x":0.853,"y":0.308,"w":0.222,"h":0.125}', '2026-04-24 23:26:52'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.80, '{"x":0.316,"y":0.034,"w":0.34,"h":0.137}', '2026-04-30 03:48:41'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.77, '{"x":0.241,"y":0.162,"w":0.115,"h":0.342}', '2026-04-16 19:29:31'),
      (1, 'seed-cam-admin-recp', 'Reception', 'fire', NULL, 0.79, '{"x":0.326,"y":0.328,"w":0.24,"h":0.158}', '2026-05-08 14:47:36'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Jane', 0.75, '{"x":0.34,"y":0.378,"w":0.168,"h":0.246}', '2026-05-02 15:50:24'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.71, '{"x":0.255,"y":0.101,"w":0.212,"h":0.209}', '2026-04-25 23:10:06'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Tonoy', 0.80, '{"x":0.832,"y":0.352,"w":0.321,"h":0.338}', '2026-04-17 11:39:35'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.78, '{"x":0.014,"y":0.478,"w":0.137,"h":0.247}', '2026-05-10 04:44:45'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', NULL, 0.68, '{"x":0.64,"y":0.27,"w":0.23,"h":0.101}', '2026-04-11 20:08:33'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Jane', 0.65, '{"x":0.508,"y":0.179,"w":0.265,"h":0.376}', '2026-05-09 04:23:13'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', 'Ankon', 0.74, '{"x":0.602,"y":0.128,"w":0.228,"h":0.378}', '2026-04-21 06:48:52'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.61, '{"x":0.699,"y":0.122,"w":0.393,"h":0.224}', '2026-05-06 13:25:56'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Jane', 0.81, '{"x":0.811,"y":0.136,"w":0.149,"h":0.306}', '2026-04-30 00:39:19'),
      (1, 'seed-cam-admin-recp', 'Reception', 'fire', NULL, 0.98, '{"x":0.557,"y":0.29,"w":0.148,"h":0.344}', '2026-04-30 19:20:43'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.70, '{"x":0.51,"y":0.127,"w":0.285,"h":0.203}', '2026-04-16 22:49:19'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', 'Tonoy', 0.61, '{"x":0.253,"y":0.151,"w":0.262,"h":0.185}', '2026-04-28 03:18:42'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.62, '{"x":0.028,"y":0.352,"w":0.157,"h":0.176}', '2026-04-24 01:45:35'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'fire', NULL, 0.97, '{"x":0.255,"y":0.205,"w":0.168,"h":0.288}', '2026-05-07 07:37:24'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.77, '{"x":0.866,"y":0.025,"w":0.328,"h":0.187}', '2026-04-23 03:32:07'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.76, '{"x":0.604,"y":0.368,"w":0.153,"h":0.37}', '2026-04-25 10:12:59'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', NULL, 0.67, '{"x":0.353,"y":0.383,"w":0.268,"h":0.343}', '2026-04-19 11:56:47'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.60, '{"x":0.186,"y":0.382,"w":0.247,"h":0.114}', '2026-04-11 08:51:33'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.70, '{"x":0.068,"y":0.12,"w":0.322,"h":0.214}', '2026-05-09 16:24:54'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Tonoy', 0.63, '{"x":0.409,"y":0.003,"w":0.196,"h":0.221}', '2026-04-22 19:49:30'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.71, '{"x":0.489,"y":0.302,"w":0.156,"h":0.359}', '2026-04-14 12:56:42'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'fire', NULL, 0.93, '{"x":0.13,"y":0.219,"w":0.181,"h":0.163}', '2026-05-04 06:13:43'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'person', NULL, 0.93, '{"x":0.066,"y":0.44,"w":0.251,"h":0.144}', '2026-05-08 18:15:12'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.95, '{"x":0.381,"y":0.007,"w":0.121,"h":0.232}', '2026-05-07 00:42:46'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', 'Tonoy', 0.72, '{"x":0.688,"y":0.126,"w":0.396,"h":0.377}', '2026-04-21 22:52:56'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.68, '{"x":0.863,"y":0.419,"w":0.326,"h":0.381}', '2026-04-12 09:26:44'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', 'Tonoy', 0.85, '{"x":0.587,"y":0.45,"w":0.239,"h":0.326}', '2026-05-10 02:51:30'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.66, '{"x":0.633,"y":0.39,"w":0.205,"h":0.157}', '2026-04-13 13:35:33'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Jane', 0.71, '{"x":0.419,"y":0.42,"w":0.229,"h":0.185}', '2026-05-09 01:05:46'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.98, '{"x":0.137,"y":0.294,"w":0.317,"h":0.348}', '2026-04-26 05:37:55'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', 'Tonoy', 0.84, '{"x":0.951,"y":0.451,"w":0.275,"h":0.326}', '2026-04-29 01:18:19'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'smoke', NULL, 0.60, '{"x":0.87,"y":0.154,"w":0.291,"h":0.103}', '2026-04-11 12:21:28'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.86, '{"x":0.291,"y":0.404,"w":0.35,"h":0.146}', '2026-05-05 01:23:08'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Jane', 0.63, '{"x":0.776,"y":0.34,"w":0.308,"h":0.117}', '2026-04-23 08:14:56'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', NULL, 0.64, '{"x":0.866,"y":0.185,"w":0.351,"h":0.31}', '2026-04-27 23:10:58'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'fire', NULL, 0.69, '{"x":0.528,"y":0.295,"w":0.346,"h":0.361}', '2026-04-27 19:51:24'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'fire', NULL, 0.85, '{"x":0.019,"y":0.004,"w":0.125,"h":0.363}', '2026-05-09 01:06:17'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Ankon', 0.83, '{"x":0.143,"y":0.306,"w":0.229,"h":0.372}', '2026-05-01 20:44:11'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.66, '{"x":0.281,"y":0.328,"w":0.304,"h":0.203}', '2026-04-11 19:27:00'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'face', 'Tonoy', 0.86, '{"x":0.473,"y":0.191,"w":0.231,"h":0.128}', '2026-05-02 15:38:14'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'smoke', NULL, 0.83, '{"x":0.678,"y":0.047,"w":0.107,"h":0.157}', '2026-04-14 09:11:01'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Ankon', 0.72, '{"x":0.829,"y":0.081,"w":0.196,"h":0.189}', '2026-04-27 01:31:42'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.66, '{"x":0.869,"y":0.092,"w":0.151,"h":0.388}', '2026-05-09 15:42:00'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.67, '{"x":0.817,"y":0.325,"w":0.388,"h":0.109}', '2026-05-05 02:28:53'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'smoke', NULL, 0.83, '{"x":0.887,"y":0.382,"w":0.364,"h":0.141}', '2026-04-27 14:59:20'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', NULL, 0.87, '{"x":0.013,"y":0.361,"w":0.186,"h":0.36}', '2026-04-20 03:22:55'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.63, '{"x":0.126,"y":0.06,"w":0.112,"h":0.299}', '2026-04-23 15:27:46'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Jane', 0.67, '{"x":0.525,"y":0.375,"w":0.376,"h":0.239}', '2026-04-18 15:42:16'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'person', NULL, 0.92, '{"x":0.988,"y":0.462,"w":0.165,"h":0.158}', '2026-04-18 21:06:28'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Tonoy', 0.84, '{"x":0.222,"y":0.072,"w":0.237,"h":0.316}', '2026-04-18 21:11:28'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'face', 'Tonoy', 0.72, '{"x":0.407,"y":0.406,"w":0.121,"h":0.261}', '2026-04-26 05:41:59'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Ankon', 0.65, '{"x":0.296,"y":0.334,"w":0.274,"h":0.319}', '2026-04-19 11:41:24'),
      (1, 'seed-cam-admin-park', 'Parking Lot', 'person', NULL, 0.97, '{"x":0.768,"y":0.304,"w":0.355,"h":0.106}', '2026-04-25 13:15:44'),
      (1, 'seed-cam-admin-recp', 'Reception', 'face', 'Ankon', 0.73, '{"x":0.662,"y":0.199,"w":0.283,"h":0.289}', '2026-04-27 06:40:42'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Tonoy', 0.74, '{"x":0.459,"y":0.08,"w":0.389,"h":0.325}', '2026-05-03 03:14:31'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'person', NULL, 0.73, '{"x":0.745,"y":0.101,"w":0.173,"h":0.327}', '2026-05-01 10:02:48'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'smoke', NULL, 0.74, '{"x":0.309,"y":0.176,"w":0.338,"h":0.144}', '2026-04-22 07:35:16'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', NULL, 0.64, '{"x":0.73,"y":0.408,"w":0.38,"h":0.278}', '2026-05-07 17:41:28'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'person', NULL, 0.81, '{"x":0.715,"y":0.039,"w":0.205,"h":0.194}', '2026-04-27 23:06:02'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'person', NULL, 0.64, '{"x":0.275,"y":0.116,"w":0.395,"h":0.136}', '2026-04-12 00:16:40'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Ankon', 0.97, '{"x":0.037,"y":0.029,"w":0.297,"h":0.223}', '2026-04-13 06:47:57'),
      (1, 'seed-cam-admin-stor', 'Storage Room', 'fire', NULL, 0.81, '{"x":0.799,"y":0.383,"w":0.226,"h":0.222}', '2026-05-01 03:37:33'),
      (1, 'seed-cam-admin-recp', 'Reception', 'person', NULL, 0.65, '{"x":0.077,"y":0.082,"w":0.143,"h":0.177}', '2026-05-02 13:10:35'),
      (1, 'seed-cam-admin-main', 'Main Entrance', 'face', 'Ankon', 0.66, '{"x":0.761,"y":0.489,"w":0.259,"h":0.343}', '2026-04-23 21:29:59'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'person', NULL, 0.78, '{"x":0.723,"y":0.149,"w":0.213,"h":0.129}', '2026-04-26 04:55:51'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.71, '{"x":0.369,"y":0.083,"w":0.244,"h":0.301}', '2026-04-20 09:28:26'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'face', 'Jane', 0.63, '{"x":0.01,"y":0.163,"w":0.26,"h":0.215}', '2026-04-26 03:42:25'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.88, '{"x":0.545,"y":0.283,"w":0.308,"h":0.387}', '2026-04-11 07:34:55'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.99, '{"x":0.658,"y":0.497,"w":0.139,"h":0.222}', '2026-05-09 12:53:19'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.81, '{"x":0.042,"y":0.391,"w":0.13,"h":0.248}', '2026-05-09 05:53:41'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'face', NULL, 0.73, '{"x":0.9,"y":0.358,"w":0.128,"h":0.305}', '2026-04-11 12:15:13'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.99, '{"x":0.579,"y":0.098,"w":0.342,"h":0.227}', '2026-04-21 09:14:14'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.77, '{"x":0.827,"y":0.188,"w":0.171,"h":0.383}', '2026-05-03 14:36:44'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', NULL, 0.92, '{"x":0.399,"y":0.11,"w":0.338,"h":0.289}', '2026-04-21 15:43:10'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.70, '{"x":0.699,"y":0.492,"w":0.173,"h":0.395}', '2026-05-08 19:14:37'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'face', NULL, 0.71, '{"x":0.258,"y":0.488,"w":0.389,"h":0.374}', '2026-04-23 08:52:01'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.90, '{"x":0.72,"y":0.441,"w":0.137,"h":0.249}', '2026-05-06 12:25:33'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'face', NULL, 0.77, '{"x":0.756,"y":0.336,"w":0.256,"h":0.338}', '2026-04-28 08:19:56'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.65, '{"x":0.896,"y":0.165,"w":0.13,"h":0.253}', '2026-05-09 19:02:28'),
      (2, 'seed-cam-rampura', 'Rampura', 'smoke', NULL, 0.70, '{"x":0.717,"y":0.145,"w":0.329,"h":0.114}', '2026-05-05 01:18:09'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'smoke', NULL, 0.95, '{"x":0.496,"y":0.275,"w":0.398,"h":0.162}', '2026-05-07 18:31:37'),
      (2, 'seed-cam-rampura', 'Rampura', 'person', NULL, 0.98, '{"x":0.794,"y":0.173,"w":0.353,"h":0.173}', '2026-04-28 12:05:14'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', 'Jane', 0.68, '{"x":0.763,"y":0.298,"w":0.344,"h":0.136}', '2026-05-01 10:39:11'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'face', NULL, 0.77, '{"x":0.182,"y":0.296,"w":0.292,"h":0.388}', '2026-04-23 04:24:36'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', NULL, 0.69, '{"x":0.251,"y":0.196,"w":0.298,"h":0.309}', '2026-04-20 09:37:43'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'face', NULL, 0.96, '{"x":0.984,"y":0.179,"w":0.321,"h":0.36}', '2026-04-20 03:37:46'),
      (2, 'seed-cam-rampura', 'Rampura', 'smoke', NULL, 0.61, '{"x":0.747,"y":0.407,"w":0.381,"h":0.168}', '2026-04-20 18:51:43'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'face', 'Ankon', 0.86, '{"x":0.585,"y":0.227,"w":0.302,"h":0.112}', '2026-05-10 02:16:08'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'smoke', NULL, 0.88, '{"x":0.757,"y":0.277,"w":0.244,"h":0.312}', '2026-05-01 17:00:15'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.95, '{"x":0.642,"y":0.239,"w":0.38,"h":0.282}', '2026-05-01 22:04:28'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'person', NULL, 0.61, '{"x":0.278,"y":0.221,"w":0.155,"h":0.148}', '2026-04-18 06:44:36'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.62, '{"x":0.319,"y":0.254,"w":0.255,"h":0.122}', '2026-05-07 00:23:00'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'fire', NULL, 0.72, '{"x":0.174,"y":0.276,"w":0.309,"h":0.237}', '2026-04-11 03:02:54'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'face', 'Jane', 0.81, '{"x":0.315,"y":0.234,"w":0.38,"h":0.209}', '2026-05-04 03:16:55'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Jane', 0.95, '{"x":0.603,"y":0.227,"w":0.382,"h":0.219}', '2026-05-08 06:25:41'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.96, '{"x":0.453,"y":0.258,"w":0.355,"h":0.187}', '2026-04-18 03:20:19'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.82, '{"x":0.824,"y":0.239,"w":0.224,"h":0.22}', '2026-05-04 20:50:57'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'fire', NULL, 0.85, '{"x":0.624,"y":0.192,"w":0.353,"h":0.303}', '2026-04-26 14:58:01'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'person', NULL, 0.81, '{"x":0.463,"y":0.356,"w":0.169,"h":0.3}', '2026-05-08 15:39:41'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'fire', NULL, 0.65, '{"x":0.817,"y":0.335,"w":0.366,"h":0.291}', '2026-04-22 19:30:04'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'smoke', NULL, 0.62, '{"x":0.077,"y":0.256,"w":0.142,"h":0.128}', '2026-04-15 14:29:42'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Ankon', 0.73, '{"x":0.721,"y":0.249,"w":0.328,"h":0.312}', '2026-04-17 02:59:15'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'fire', NULL, 0.74, '{"x":0.963,"y":0.242,"w":0.358,"h":0.382}', '2026-05-10 10:25:27'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', 'Jane', 0.78, '{"x":0.275,"y":0.038,"w":0.118,"h":0.168}', '2026-04-30 11:44:34'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'person', NULL, 0.60, '{"x":0.952,"y":0.24,"w":0.33,"h":0.152}', '2026-05-05 01:35:21'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'face', 'Jane', 0.79, '{"x":0.654,"y":0.34,"w":0.302,"h":0.214}', '2026-04-24 11:48:04'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', 'Jane', 0.95, '{"x":0.613,"y":0.377,"w":0.391,"h":0.371}', '2026-04-30 07:59:04'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', NULL, 0.60, '{"x":0.763,"y":0.085,"w":0.284,"h":0.271}', '2026-04-12 14:29:53'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.84, '{"x":0.471,"y":0.192,"w":0.294,"h":0.333}', '2026-04-24 01:12:33'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'face', 'Jane', 0.69, '{"x":0.762,"y":0.442,"w":0.195,"h":0.317}', '2026-05-01 23:42:18'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'face', 'Tonoy', 0.81, '{"x":0.281,"y":0.08,"w":0.208,"h":0.312}', '2026-04-22 19:02:27'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.93, '{"x":0.625,"y":0.04,"w":0.238,"h":0.235}', '2026-04-28 18:18:21'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'face', 'Tonoy', 0.82, '{"x":0.317,"y":0.004,"w":0.27,"h":0.177}', '2026-05-05 20:46:49'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'person', NULL, 0.76, '{"x":0.356,"y":0.1,"w":0.168,"h":0.153}', '2026-05-06 20:58:00'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'face', 'Tonoy', 0.66, '{"x":0.159,"y":0.086,"w":0.187,"h":0.391}', '2026-05-10 10:18:26'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.85, '{"x":0.251,"y":0.314,"w":0.323,"h":0.295}', '2026-05-05 13:10:25'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'person', NULL, 0.84, '{"x":0.974,"y":0.225,"w":0.39,"h":0.313}', '2026-04-15 22:15:34'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'face', 'Jane', 0.71, '{"x":0.204,"y":0.195,"w":0.176,"h":0.244}', '2026-04-28 23:49:23'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'person', NULL, 0.69, '{"x":0.545,"y":0.138,"w":0.215,"h":0.294}', '2026-05-02 14:13:49'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'face', NULL, 0.79, '{"x":0.707,"y":0.397,"w":0.206,"h":0.396}', '2026-04-28 19:25:26'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.73, '{"x":0.017,"y":0.29,"w":0.111,"h":0.125}', '2026-05-10 08:18:36'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'person', NULL, 0.69, '{"x":0.877,"y":0.198,"w":0.12,"h":0.283}', '2026-05-09 14:46:42'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'person', NULL, 0.75, '{"x":0.45,"y":0.239,"w":0.302,"h":0.327}', '2026-05-09 01:05:05'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'smoke', NULL, 0.71, '{"x":0.934,"y":0.215,"w":0.395,"h":0.3}', '2026-05-07 11:15:14'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', 'Tonoy', 0.80, '{"x":0.403,"y":0.024,"w":0.283,"h":0.13}', '2026-04-24 04:30:15'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'person', NULL, 0.86, '{"x":0.822,"y":0.085,"w":0.103,"h":0.316}', '2026-05-02 18:08:43'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', NULL, 0.64, '{"x":0.459,"y":0.275,"w":0.11,"h":0.13}', '2026-05-07 23:14:57'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'face', 'Jane', 0.67, '{"x":0.611,"y":0.104,"w":0.395,"h":0.268}', '2026-05-02 05:23:04'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'smoke', NULL, 0.66, '{"x":0.278,"y":0.237,"w":0.285,"h":0.224}', '2026-04-20 04:47:49'),
      (2, 'seed-cam-rampura', 'Rampura', 'person', NULL, 0.73, '{"x":0.53,"y":0.169,"w":0.286,"h":0.364}', '2026-05-01 13:31:45'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'person', NULL, 0.70, '{"x":0.016,"y":0.031,"w":0.254,"h":0.319}', '2026-04-21 20:05:23'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'face', 'Tonoy', 0.82, '{"x":0.182,"y":0.04,"w":0.273,"h":0.201}', '2026-04-13 03:24:00'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'smoke', NULL, 0.79, '{"x":0.859,"y":0.039,"w":0.393,"h":0.156}', '2026-05-09 11:58:15'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', 'Ankon', 0.93, '{"x":0.043,"y":0.063,"w":0.374,"h":0.139}', '2026-05-02 05:05:00'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'face', 'Jane', 0.61, '{"x":0.785,"y":0.261,"w":0.268,"h":0.332}', '2026-04-26 19:19:31'),
      (2, 'seed-cam-rampura', 'Rampura', 'smoke', NULL, 0.84, '{"x":0.144,"y":0.109,"w":0.371,"h":0.114}', '2026-05-10 07:49:09'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'smoke', NULL, 0.66, '{"x":0.904,"y":0.412,"w":0.327,"h":0.382}', '2026-04-24 10:36:08'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.62, '{"x":0.602,"y":0.015,"w":0.138,"h":0.217}', '2026-05-06 18:21:25'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'person', NULL, 0.92, '{"x":0.141,"y":0.021,"w":0.244,"h":0.242}', '2026-04-15 03:42:24'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Ankon', 0.85, '{"x":0.625,"y":0.459,"w":0.12,"h":0.283}', '2026-04-22 01:17:11'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'face', 'Ankon', 0.68, '{"x":0.958,"y":0.444,"w":0.258,"h":0.227}', '2026-05-10 03:36:54'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.90, '{"x":0.087,"y":0.162,"w":0.367,"h":0.192}', '2026-04-29 19:20:06'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Ankon', 0.70, '{"x":0.616,"y":0.039,"w":0.293,"h":0.359}', '2026-05-01 05:44:10'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.82, '{"x":0.932,"y":0.267,"w":0.38,"h":0.14}', '2026-04-17 01:44:26'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'fire', NULL, 0.92, '{"x":0.912,"y":0.189,"w":0.341,"h":0.209}', '2026-04-29 13:44:55'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'face', 'Jane', 0.79, '{"x":0.452,"y":0.271,"w":0.215,"h":0.348}', '2026-04-11 16:07:43'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', NULL, 0.84, '{"x":0.201,"y":0.433,"w":0.211,"h":0.163}', '2026-05-07 00:13:44'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', 'Jane', 0.72, '{"x":0.228,"y":0.24,"w":0.297,"h":0.374}', '2026-04-12 02:27:59'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'face', 'Tonoy', 0.80, '{"x":0.8,"y":0.402,"w":0.337,"h":0.177}', '2026-05-08 21:03:03'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'person', NULL, 0.78, '{"x":0.833,"y":0.483,"w":0.247,"h":0.256}', '2026-05-07 18:36:01'),
      (2, 'seed-cam-rampura', 'Rampura', 'person', NULL, 0.61, '{"x":0.668,"y":0.368,"w":0.109,"h":0.171}', '2026-04-19 04:11:11'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'smoke', NULL, 0.72, '{"x":0.678,"y":0.004,"w":0.139,"h":0.26}', '2026-04-23 17:11:02'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.65, '{"x":0.395,"y":0.313,"w":0.313,"h":0.215}', '2026-05-03 19:01:17'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'person', NULL, 0.65, '{"x":0.097,"y":0.166,"w":0.244,"h":0.244}', '2026-04-18 21:08:10'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'person', NULL, 0.92, '{"x":0.645,"y":0.015,"w":0.239,"h":0.143}', '2026-04-18 02:04:43'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'face', NULL, 0.94, '{"x":0.92,"y":0.241,"w":0.312,"h":0.364}', '2026-04-19 11:24:13'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.80, '{"x":0.518,"y":0.481,"w":0.175,"h":0.222}', '2026-04-10 20:46:07'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'fire', NULL, 0.65, '{"x":0.042,"y":0.375,"w":0.298,"h":0.301}', '2026-04-26 06:08:57'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'face', NULL, 0.74, '{"x":0.008,"y":0.143,"w":0.157,"h":0.176}', '2026-05-03 22:30:53'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.95, '{"x":0.881,"y":0.282,"w":0.362,"h":0.201}', '2026-05-08 04:10:28'),
      (2, 'seed-cam-badda', 'Badda DIT Project', 'person', NULL, 0.85, '{"x":0.583,"y":0.324,"w":0.127,"h":0.212}', '2026-05-09 22:38:04'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Tonoy', 0.62, '{"x":0.879,"y":0.284,"w":0.356,"h":0.293}', '2026-04-25 18:38:30'),
      (2, 'seed-cam-rampura', 'Rampura', 'fire', NULL, 0.83, '{"x":0.565,"y":0.184,"w":0.362,"h":0.332}', '2026-04-11 20:40:02'),
      (2, 'seed-cam-gulshan2', 'Gulshan-2 Circle', 'face', 'Tonoy', 0.98, '{"x":0.531,"y":0.05,"w":0.325,"h":0.188}', '2026-05-05 22:37:19'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'person', NULL, 0.82, '{"x":0.146,"y":0.453,"w":0.243,"h":0.384}', '2026-04-18 18:57:37'),
      (2, 'seed-cam-rampura', 'Rampura', 'fire', NULL, 0.76, '{"x":0.882,"y":0.25,"w":0.314,"h":0.315}', '2026-04-29 16:07:26'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'fire', NULL, 0.78, '{"x":0.376,"y":0.194,"w":0.354,"h":0.285}', '2026-04-22 07:57:03'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'face', 'Ankon', 0.79, '{"x":0.663,"y":0.488,"w":0.296,"h":0.11}', '2026-05-05 11:36:43'),
      (2, 'seed-cam-gulshan1', 'Gulshan-1 Circle', 'face', 'Tonoy', 0.64, '{"x":0.911,"y":0.458,"w":0.16,"h":0.342}', '2026-04-22 16:26:13'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', NULL, 0.93, '{"x":0.467,"y":0.091,"w":0.354,"h":0.129}', '2026-05-09 05:42:32'),
      (2, 'seed-cam-aftabnagar', 'Aftabnagar', 'fire', NULL, 0.71, '{"x":0.587,"y":0.312,"w":0.221,"h":0.274}', '2026-05-10 05:20:03'),
      (2, 'seed-cam-rampura', 'Rampura', 'face', 'Ankon', 0.81, '{"x":0.596,"y":0.208,"w":0.294,"h":0.121}', '2026-04-22 00:38:21'),
      (2, 'seed-cam-notunbzar', 'Notun Bazar', 'person', NULL, 0.76, '{"x":0.854,"y":0.197,"w":0.245,"h":0.213}', '2026-04-14 14:25:06'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.91, '{"x":0.62,"y":0.157,"w":0.376,"h":0.37}', '2026-04-18 07:27:39'),
      (3, 'seed-cam-alice-off', 'Office Front', 'person', NULL, 0.73, '{"x":0.147,"y":0.221,"w":0.191,"h":0.284}', '2026-05-03 15:47:51'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', NULL, 0.69, '{"x":0.386,"y":0.166,"w":0.169,"h":0.214}', '2026-05-10 00:13:00'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', NULL, 0.93, '{"x":0.592,"y":0.029,"w":0.115,"h":0.324}', '2026-04-16 13:27:12'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'person', NULL, 0.87, '{"x":0.389,"y":0.208,"w":0.352,"h":0.167}', '2026-04-20 08:43:23'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.63, '{"x":0.714,"y":0.225,"w":0.341,"h":0.274}', '2026-05-01 13:32:19'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', NULL, 0.69, '{"x":0.445,"y":0.197,"w":0.208,"h":0.172}', '2026-05-08 05:57:33'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', NULL, 0.71, '{"x":0.504,"y":0.186,"w":0.155,"h":0.25}', '2026-04-25 08:59:29'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Ankon', 0.71, '{"x":0.983,"y":0.341,"w":0.31,"h":0.272}', '2026-04-24 12:01:26'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.66, '{"x":0.061,"y":0.211,"w":0.333,"h":0.284}', '2026-05-06 17:25:15'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Tonoy', 0.64, '{"x":0.129,"y":0.294,"w":0.148,"h":0.174}', '2026-05-10 08:09:39'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Ankon', 0.93, '{"x":0.161,"y":0.329,"w":0.387,"h":0.183}', '2026-05-09 17:50:40'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Jane', 0.87, '{"x":0.159,"y":0.412,"w":0.13,"h":0.208}', '2026-05-03 14:43:24'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Jane', 0.75, '{"x":0.691,"y":0.167,"w":0.381,"h":0.127}', '2026-04-17 19:04:07'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', NULL, 0.94, '{"x":0.702,"y":0.252,"w":0.235,"h":0.352}', '2026-05-01 23:32:38'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Tonoy', 0.89, '{"x":0.477,"y":0.494,"w":0.224,"h":0.319}', '2026-05-06 09:32:01'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', NULL, 0.60, '{"x":0.724,"y":0.385,"w":0.244,"h":0.218}', '2026-04-25 06:15:54'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'person', NULL, 0.98, '{"x":0.412,"y":0.334,"w":0.389,"h":0.232}', '2026-04-18 03:23:23'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.76, '{"x":0.219,"y":0.193,"w":0.169,"h":0.15}', '2026-05-10 06:51:33'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', NULL, 0.60, '{"x":0.234,"y":0.335,"w":0.359,"h":0.305}', '2026-05-10 07:04:13'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Tonoy', 0.90, '{"x":0.83,"y":0.046,"w":0.253,"h":0.148}', '2026-05-02 03:55:16'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', NULL, 0.92, '{"x":0.379,"y":0.335,"w":0.228,"h":0.216}', '2026-05-07 20:44:24'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.88, '{"x":0.793,"y":0.127,"w":0.172,"h":0.367}', '2026-04-25 05:18:39'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.85, '{"x":0.217,"y":0.209,"w":0.133,"h":0.157}', '2026-04-21 16:51:15'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', NULL, 0.88, '{"x":0.957,"y":0.337,"w":0.357,"h":0.185}', '2026-04-24 01:28:50'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'fire', NULL, 0.91, '{"x":0.954,"y":0.179,"w":0.337,"h":0.388}', '2026-05-02 13:06:15'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Tonoy', 0.67, '{"x":0.426,"y":0.195,"w":0.266,"h":0.183}', '2026-04-17 05:14:28'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.82, '{"x":0.373,"y":0.229,"w":0.279,"h":0.142}', '2026-05-09 22:06:35'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Tonoy', 0.88, '{"x":0.182,"y":0.185,"w":0.398,"h":0.109}', '2026-04-10 14:09:01'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'smoke', NULL, 0.69, '{"x":0.316,"y":0.064,"w":0.359,"h":0.263}', '2026-05-08 10:40:01'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'smoke', NULL, 0.71, '{"x":0.912,"y":0.311,"w":0.38,"h":0.106}', '2026-04-30 01:03:47'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Jane', 0.79, '{"x":0.102,"y":0.474,"w":0.376,"h":0.192}', '2026-04-14 16:09:45'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Jane', 0.61, '{"x":0.38,"y":0.341,"w":0.278,"h":0.111}', '2026-04-22 06:11:08'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'smoke', NULL, 0.70, '{"x":0.285,"y":0.098,"w":0.104,"h":0.254}', '2026-04-30 20:25:00'),
      (3, 'seed-cam-alice-off', 'Office Front', 'person', NULL, 0.69, '{"x":0.651,"y":0.17,"w":0.283,"h":0.254}', '2026-04-12 10:06:18'),
      (3, 'seed-cam-alice-off', 'Office Front', 'person', NULL, 0.94, '{"x":0.87,"y":0.432,"w":0.148,"h":0.191}', '2026-05-05 09:16:24'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Ankon', 0.70, '{"x":0.509,"y":0.042,"w":0.382,"h":0.228}', '2026-04-23 19:23:02'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'smoke', NULL, 0.68, '{"x":0.258,"y":0.136,"w":0.275,"h":0.224}', '2026-05-05 06:54:31'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'smoke', NULL, 0.89, '{"x":0.196,"y":0.34,"w":0.144,"h":0.183}', '2026-05-01 23:28:43'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'person', NULL, 0.67, '{"x":0.344,"y":0.04,"w":0.284,"h":0.323}', '2026-04-25 22:03:50'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Jane', 0.76, '{"x":0.081,"y":0.002,"w":0.239,"h":0.34}', '2026-04-14 06:45:42'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Jane', 0.64, '{"x":0.837,"y":0.092,"w":0.174,"h":0.307}', '2026-04-10 23:24:24'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.90, '{"x":0.63,"y":0.16,"w":0.128,"h":0.106}', '2026-05-06 04:38:41'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Tonoy', 0.90, '{"x":0.087,"y":0.033,"w":0.145,"h":0.186}', '2026-04-23 12:47:11'),
      (3, 'seed-cam-alice-off', 'Office Front', 'smoke', NULL, 0.96, '{"x":0.322,"y":0.326,"w":0.363,"h":0.154}', '2026-05-08 17:28:15'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.71, '{"x":0.687,"y":0.34,"w":0.145,"h":0.206}', '2026-05-07 16:53:03'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Ankon', 0.69, '{"x":0.031,"y":0.281,"w":0.104,"h":0.19}', '2026-05-10 05:20:07'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.93, '{"x":0.344,"y":0.208,"w":0.107,"h":0.18}', '2026-04-18 15:18:50'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Ankon', 0.68, '{"x":0.713,"y":0.366,"w":0.218,"h":0.127}', '2026-05-09 13:51:42'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Tonoy', 0.78, '{"x":0.99,"y":0.237,"w":0.125,"h":0.267}', '2026-04-28 10:56:25'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.73, '{"x":0.177,"y":0.079,"w":0.165,"h":0.326}', '2026-05-04 18:19:29'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Jane', 0.89, '{"x":0.269,"y":0.214,"w":0.353,"h":0.364}', '2026-05-06 01:09:29'),
      (3, 'seed-cam-alice-off', 'Office Front', 'person', NULL, 0.73, '{"x":0.987,"y":0.287,"w":0.125,"h":0.319}', '2026-05-10 07:03:51'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Ankon', 0.65, '{"x":0.482,"y":0.287,"w":0.39,"h":0.218}', '2026-05-05 18:06:32'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Tonoy', 0.68, '{"x":0.11,"y":0.282,"w":0.138,"h":0.137}', '2026-05-03 18:43:15'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'smoke', NULL, 0.91, '{"x":0.736,"y":0.045,"w":0.379,"h":0.142}', '2026-04-17 06:34:43'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.97, '{"x":0.918,"y":0.066,"w":0.249,"h":0.147}', '2026-04-26 19:47:24'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Tonoy', 0.82, '{"x":0.586,"y":0.016,"w":0.363,"h":0.284}', '2026-05-08 09:56:01'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'smoke', NULL, 0.96, '{"x":0.13,"y":0.202,"w":0.138,"h":0.292}', '2026-04-21 22:36:04'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.79, '{"x":0.119,"y":0.476,"w":0.336,"h":0.37}', '2026-04-28 17:42:29'),
      (3, 'seed-cam-alice-off', 'Office Front', 'smoke', NULL, 0.67, '{"x":0.167,"y":0.304,"w":0.132,"h":0.162}', '2026-04-16 16:21:07'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Tonoy', 0.97, '{"x":0.125,"y":0.087,"w":0.112,"h":0.16}', '2026-04-11 18:13:37'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Ankon', 0.82, '{"x":0.584,"y":0.389,"w":0.191,"h":0.366}', '2026-04-29 14:45:31'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Jane', 0.80, '{"x":0.511,"y":0.076,"w":0.199,"h":0.388}', '2026-05-05 14:32:05'),
      (3, 'seed-cam-alice-off', 'Office Front', 'fire', NULL, 0.76, '{"x":0.665,"y":0.396,"w":0.175,"h":0.326}', '2026-05-09 18:09:53'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Jane', 0.94, '{"x":0.854,"y":0.122,"w":0.346,"h":0.167}', '2026-05-02 11:21:11'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'fire', NULL, 0.70, '{"x":0.583,"y":0.157,"w":0.387,"h":0.213}', '2026-05-03 03:14:31'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Ankon', 0.63, '{"x":0.882,"y":0.063,"w":0.295,"h":0.327}', '2026-05-10 05:50:50'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.77, '{"x":0.553,"y":0.285,"w":0.117,"h":0.111}', '2026-04-27 02:02:15'),
      (3, 'seed-cam-alice-off', 'Office Front', 'smoke', NULL, 0.97, '{"x":0.86,"y":0.364,"w":0.104,"h":0.163}', '2026-05-07 23:16:46'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Jane', 0.77, '{"x":0.065,"y":0.452,"w":0.257,"h":0.292}', '2026-04-14 11:29:13'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.98, '{"x":0.088,"y":0.38,"w":0.23,"h":0.241}', '2026-05-06 04:18:50'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'person', NULL, 0.63, '{"x":0.95,"y":0.275,"w":0.329,"h":0.379}', '2026-04-27 13:21:27'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.73, '{"x":0.532,"y":0.059,"w":0.212,"h":0.171}', '2026-05-05 04:02:50'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.94, '{"x":0.2,"y":0.456,"w":0.336,"h":0.304}', '2026-05-10 07:33:20'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.75, '{"x":0.459,"y":0.458,"w":0.148,"h":0.175}', '2026-04-27 00:21:41'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'person', NULL, 0.96, '{"x":0.573,"y":0.253,"w":0.25,"h":0.284}', '2026-04-18 04:18:11'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Tonoy', 0.66, '{"x":0.403,"y":0.344,"w":0.197,"h":0.156}', '2026-04-19 03:42:43'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.96, '{"x":0.524,"y":0.334,"w":0.267,"h":0.151}', '2026-04-28 19:15:32'),
      (3, 'seed-cam-alice-off', 'Office Front', 'person', NULL, 0.84, '{"x":0.33,"y":0.451,"w":0.304,"h":0.125}', '2026-04-17 02:17:46'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Jane', 0.64, '{"x":0.625,"y":0.477,"w":0.285,"h":0.332}', '2026-04-16 14:06:27'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'person', NULL, 0.89, '{"x":0.453,"y":0.17,"w":0.29,"h":0.289}', '2026-05-09 17:50:18'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Tonoy', 0.67, '{"x":0.904,"y":0.216,"w":0.21,"h":0.145}', '2026-04-23 14:58:22'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', NULL, 0.93, '{"x":0.208,"y":0.146,"w":0.258,"h":0.316}', '2026-05-10 06:27:14'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Tonoy', 0.81, '{"x":0.524,"y":0.332,"w":0.31,"h":0.376}', '2026-04-16 16:02:08'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', NULL, 0.86, '{"x":0.352,"y":0.49,"w":0.175,"h":0.389}', '2026-04-11 21:54:02'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Jane', 0.62, '{"x":0.525,"y":0.223,"w":0.1,"h":0.28}', '2026-04-26 16:24:49'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Tonoy', 0.72, '{"x":0.165,"y":0.203,"w":0.179,"h":0.144}', '2026-05-10 06:54:22'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Tonoy', 0.76, '{"x":0.3,"y":0.123,"w":0.151,"h":0.178}', '2026-04-27 23:36:42'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Ankon', 0.97, '{"x":0.627,"y":0.478,"w":0.12,"h":0.318}', '2026-04-25 15:47:36'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'fire', NULL, 0.97, '{"x":0.951,"y":0.118,"w":0.362,"h":0.161}', '2026-04-28 03:12:09'),
      (3, 'seed-cam-alice-off', 'Office Front', 'person', NULL, 0.69, '{"x":0.404,"y":0.09,"w":0.24,"h":0.235}', '2026-04-22 10:50:15'),
      (3, 'seed-cam-alice-off', 'Office Front', 'person', NULL, 0.90, '{"x":0.795,"y":0.367,"w":0.303,"h":0.211}', '2026-04-18 10:35:55'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Jane', 0.66, '{"x":0.644,"y":0.411,"w":0.219,"h":0.275}', '2026-05-09 17:47:59'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Tonoy', 0.71, '{"x":0.731,"y":0.4,"w":0.141,"h":0.365}', '2026-05-10 00:06:47'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'smoke', NULL, 0.65, '{"x":0.07,"y":0.168,"w":0.153,"h":0.173}', '2026-05-09 04:06:53'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', NULL, 0.88, '{"x":0.483,"y":0.22,"w":0.36,"h":0.263}', '2026-04-15 18:14:15'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'person', NULL, 0.83, '{"x":0.526,"y":0.26,"w":0.219,"h":0.38}', '2026-04-14 10:00:11'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', 'Tonoy', 0.81, '{"x":0.579,"y":0.349,"w":0.248,"h":0.255}', '2026-04-29 18:17:28'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', 'Ankon', 0.65, '{"x":0.904,"y":0.251,"w":0.266,"h":0.279}', '2026-04-17 05:10:28'),
      (3, 'seed-cam-alice-off', 'Office Front', 'face', NULL, 0.64, '{"x":0.113,"y":0.254,"w":0.265,"h":0.379}', '2026-05-03 07:01:45'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'smoke', NULL, 0.84, '{"x":0.075,"y":0.409,"w":0.342,"h":0.327}', '2026-04-27 05:15:20'),
      (3, 'seed-cam-alice-srv', 'Server Room', 'face', NULL, 0.69, '{"x":0.998,"y":0.15,"w":0.355,"h":0.34}', '2026-04-17 15:24:25'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'person', NULL, 0.81, '{"x":0.415,"y":0.362,"w":0.353,"h":0.194}', '2026-05-05 03:06:25'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Tonoy', 0.69, '{"x":0.907,"y":0.341,"w":0.32,"h":0.186}', '2026-05-09 16:57:28'),
      (3, 'seed-cam-alice-off', 'Office Front', 'smoke', NULL, 0.65, '{"x":0.035,"y":0.334,"w":0.108,"h":0.285}', '2026-04-20 06:26:50'),
      (3, 'seed-cam-alice-bk', 'Back Door', 'face', 'Tonoy', 0.89, '{"x":0.523,"y":0.317,"w":0.175,"h":0.289}', '2026-05-09 17:42:17'),
      (3, 'seed-cam-alice-hall', 'Hallway', 'face', 'Tonoy', 0.78, '{"x":0.856,"y":0.029,"w":0.126,"h":0.287}', '2026-05-10 04:44:32');
  END IF;
END$$
DELIMITER ;

CALL seed_sample_incidents();
DROP PROCEDURE seed_sample_incidents;


-- ────────────────────────────────────────────────────────────────────────
-- Optional: drop everything (for a clean reinstall). Uncomment to use.
-- ────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS incidents;
-- DROP TABLE IF EXISTS cameras;
-- DROP TABLE IF EXISTS features;
-- DROP TABLE IF EXISTS users;
-- DROP DATABASE IF EXISTS ai_cctv;
