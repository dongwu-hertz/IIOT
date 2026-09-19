/**
 * SQLite metadata store.
 *
 * Storage contract (spec sections 4.1, 16; appendix C rules 1 & 7):
 *   SQLite  -> metadata and indexes ONLY
 *   Parquet -> long-term feature trends
 *   NTFS    -> WAV / FLAC audio
 *
 * It is therefore a bug — not a trade-off — for this file to ever hold audio
 * samples. There is deliberately no BLOB column anywhere in the schema below.
 *
 * `better-sqlite3` is synchronous by design. That is a feature here: all writes
 * happen in the main process on a dedicated path, transactions are trivially
 * correct, and there is no connection pool to leak on app exit (spec 14.4 /
 * appendix C rule 12).
 */

import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'

/** Current schema version. Bump together with a new entry in MIGRATIONS. */
export const SCHEMA_VERSION = 15

export interface Migration {
  version: number
  name: string
  up: (db: SqliteDatabase) => void
  /**
   * 这一条迁移**必须**在关闭外键强制的情况下跑（迁移器会在它前后各切一次 PRAGMA）。
   *
   * 只有"重建一张被别的表引用的表"才需要它，理由很具体：`DROP TABLE devices` 在外键打开时
   * 会**先做一次隐式 DELETE**，而 channels / alarms / recordings / samples 都是
   * `REFERENCES devices (id) ON DELETE CASCADE` —— 于是重建父表会把所有子行**级联删掉**。
   * 那是数据丢失，不是"重建的副作用"。
   *
   * 注意 `PRAGMA foreign_keys` 在**事务内部是空操作**，所以这一个开关只能由迁移器在事务
   * **外面**处理；迁移函数自己设它没用（第一版就是这么想的）。
   */
  foreignKeysOff?: boolean
}

/**
 * Ordered, append-only migrations. Never edit a shipped migration — add a new
 * one. `user_version` tracks how far a given database file has been brought.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      // -- devices (spec 16.1) ------------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id               TEXT PRIMARY KEY,
          device_uid       TEXT NOT NULL,
          name             TEXT NOT NULL,
          ip_address       TEXT,
          http_port        INTEGER,
          mac_address      TEXT,
          connection_type  TEXT NOT NULL DEFAULT 'LAN'
                             CHECK (connection_type IN ('LAN', 'REMOTE')),
          firmware_version TEXT,
          fpga_version     TEXT,
          web_version      TEXT,
          status           TEXT NOT NULL DEFAULT 'UNKNOWN'
                             CHECK (status IN ('ONLINE', 'OFFLINE', 'UNKNOWN')),
          last_seen        INTEGER,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );

        -- Identity is device_uid, never IP. Two rows sharing a device_uid are
        -- the same physical box reached at different addresses — a duplicate,
        -- not a second device (spec 6.2 step 4, spec 18 "IP 改变不生成重复设备").
        CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_uid ON devices (device_uid);
        CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status);
      `)

      // -- channels (spec 16.2) ----------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id               TEXT PRIMARY KEY,
          device_id        TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
          channel_index    INTEGER NOT NULL,
          channel_name     TEXT NOT NULL,
          sensor_type      INTEGER NOT NULL DEFAULT 0
                             CHECK (sensor_type IN (0, 1)),
          enabled          INTEGER NOT NULL DEFAULT 1,
          alarm_profile_id TEXT,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_device_index
          ON channels (device_id, channel_index);
      `)

      // -- alarm_profiles (spec 16.3) ----------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS alarm_profiles (
          id              TEXT PRIMARY KEY,
          device_id       TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
          remote_alarm_id INTEGER,
          name            TEXT NOT NULL,
          detection_type  TEXT NOT NULL DEFAULT 'Characteristic'
                            CHECK (detection_type IN ('Characteristic', 'AI')),
          config_json     TEXT NOT NULL DEFAULT '{}',
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_alarm_profiles_device
          ON alarm_profiles (device_id);
      `)

      // -- alarms (spec 16.4) ------------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS alarms (
          id                 TEXT PRIMARY KEY,
          device_id          TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
          channel_id         INTEGER NOT NULL,
          alarm_type         INTEGER,
          alarm_mask         INTEGER NOT NULL,
          alarm_time         INTEGER NOT NULL,
          spl                REAL,
          main_frequency     REAL,
          smoothness         REAL,
          band_energy_ratio  REAL,
          remote_audio_path  TEXT,
          recording_id       TEXT,
          acknowledged       INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_alarms_time ON alarms (alarm_time DESC);
        CREATE INDEX IF NOT EXISTS idx_alarms_device_time
          ON alarms (device_id, alarm_time DESC);
        CREATE INDEX IF NOT EXISTS idx_alarms_unack
          ON alarms (acknowledged, alarm_time DESC);
      `)

      // -- recordings (spec 16.5) --------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS recordings (
          id                  TEXT PRIMARY KEY,
          device_id           TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
          channel_id          INTEGER NOT NULL,
          recording_type      TEXT NOT NULL
                                CHECK (recording_type IN ('alarm', 'manual', 'scheduled')),
          event_type          TEXT,
          start_time          INTEGER NOT NULL,
          end_time            INTEGER,
          duration_ms         INTEGER,
          sample_rate         INTEGER NOT NULL,
          audio_format        TEXT NOT NULL DEFAULT 'wav'
                                CHECK (audio_format IN ('wav', 'flac')),
          -- Relative to the configured storage root, so moving the root to a
          -- bigger disk does not invalidate a single row (spec 4.4).
          relative_path       TEXT NOT NULL,
          file_size           INTEGER,
          sha256              TEXT,
          remote_recording_id TEXT,
          created_at          INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_recordings_time ON recordings (start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_recordings_device_time
          ON recordings (device_id, start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_recordings_type
          ON recordings (recording_type, start_time DESC);
        -- Device-library mirrors are keyed by the firmware's own record id.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_remote
          ON recordings (device_id, remote_recording_id)
          WHERE remote_recording_id IS NOT NULL;
      `)

      // -- settings (spec 16.6) ----------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT
        );
      `)
    }
  },
  {
    version: 2,
    name: 'device-auth-strategy',
    up: (db) => {
      // Records which token carrier the device accepted, so the auth probe
      // (spec section 19, risk 1) runs once per device rather than on every
      // app start. NULL means "not yet discovered".
      const columns = db.pragma('table_info(devices)') as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'auth_strategy')) {
        db.exec(`ALTER TABLE devices ADD COLUMN auth_strategy TEXT`)
      }
    }
  },
  {
    version: 3,
    name: 'device-kind',
    up: (db) => {
      /**
       * Product family, so one table can hold both the acoustic box and the FA371
       * acoustic camera.
       *
       * `NOT NULL DEFAULT 'acousticBox'` is the correct backfill rather than a
       * convenient one: before the camera existed, every row in this table WAS an
       * acoustic box, so an existing database is upgraded with no ambiguity and no
       * NULL that later code would have to guess about.
       *
       * The CHECK mirrors the enum in `shared/domain/models.ts`. A duplicate
       * source of truth is tolerable here because the database is the last line of
       * defence: a typo'd kind arriving over IPC must fail loudly rather than
       * produce a device the UI cannot route.
       */
      const columns = db.pragma('table_info(devices)') as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'kind')) {
        db.exec(
          `ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'acousticBox'
             CHECK (kind IN ('acousticBox', 'acousticCamera'))`
        )
      }
    }
  },
  {
    version: 4,
    name: 'application-accounts',
    up: (db) => {
      /**
       * The SOFTWARE's own accounts (spec: administrator / normal user, with a
       * recovery path). Not a device's: both supported appliances are
       * single-account and cannot express roles at all.
       *
       * `password_hash` holds a derived value (scrypt), never the password and
       * never anything reversible: the desktop app must be able to VERIFY a
       * password, not recover it. `username` is COLLATE NOCASE so `Admin` and
       * `admin` cannot become two accounts — a classic way to end up with a
       * duplicate administrator nobody notices.
       *
       * The CHECK on `role` mirrors `shared/domain/auth.ts` for the same reason
       * the device `kind` CHECK exists: a typo must fail loudly here rather than
       * produce an account the permission checks cannot classify.
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id                   TEXT PRIMARY KEY,
          username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name         TEXT,
          role                 TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
          password_hash        TEXT NOT NULL,
          must_change_password INTEGER NOT NULL DEFAULT 0,
          last_login_at        INTEGER,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

        -- Small key/value store for facts about THIS installation that are not
        -- user preferences: currently just the install id the recovery code is
        -- derived from. Kept separate from the settings table so a future settings
        -- schema change cannot silently drop the value that unlocks recovery.
        CREATE TABLE IF NOT EXISTS app_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 5,
    name: 'recording-container-format',
    up: (db) => {
      /**
       * `recordings` held a camera's MP4 clip as `audio_format = 'wav'`.
       *
       * That was not laziness, it was a CHECK constraint: column 143 of migration 1
       * only admits `wav`/`flac`, and SQLite cannot widen a CHECK in place. But the
       * cost of leaving it is a row that states something false — "this file is WAV"
       * about an MP4 — and every reader then has to know that the column lies and
       * go look at `event_type` text instead. A schema that has to be disbelieved is
       * worse than one that is merely incomplete.
       *
       * So: rebuild the table. `audio_format` becomes NULLABLE for anything that is
       * not audio (NULL = "this file has no audio format", which is true), and a new
       * `container_format` says what the bytes actually are. Both keep a CHECK, so a
       * typo still fails loudly at write time rather than producing a row nobody can
       * classify — the same reasoning as the device `kind` and user `role` CHECKs.
       *
       * `unknown` is a LEGAL value on purpose. The FA371 detection library hands us
       * file names whose extensions we do not control, and "I could not tell" must be
       * storable — otherwise the code would be pushed back into guessing, which is
       * the exact failure this migration exists to remove.
       *
       * Existing rows are converted by what they already declare: a video event gets
       * `mp4` (the only container `insertVideo` ever wrote), everything else keeps its
       * `audio_format` in both columns. Nothing is dropped.
       */
      db.exec(`
        CREATE TABLE recordings_v5 (
          id                  TEXT PRIMARY KEY,
          device_id           TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
          channel_id          INTEGER NOT NULL,
          recording_type      TEXT NOT NULL
                                CHECK (recording_type IN ('alarm', 'manual', 'scheduled')),
          event_type          TEXT,
          start_time          INTEGER NOT NULL,
          end_time            INTEGER,
          duration_ms         INTEGER,
          sample_rate         INTEGER NOT NULL,
          -- NULL means "not an audio file". A value is the audio encoding.
          audio_format        TEXT
                                CHECK (audio_format IS NULL OR audio_format IN ('wav', 'flac')),
          -- What the bytes on disk actually are, independent of whether they carry
          -- audio. 'unknown' is legal: an unrecognised extension is stored honestly
          -- instead of being coerced into a format the app merely hopes for.
          container_format    TEXT
                                CHECK (container_format IS NULL OR container_format IN (
                                  'wav', 'flac', 'mp4', 'jpg', 'png', 'csv', 'bin', 'nc', 'unknown'
                                )),
          -- Relative to the configured storage root, so moving the root to a
          -- bigger disk does not invalidate a single row (spec 4.4).
          relative_path       TEXT NOT NULL,
          file_size           INTEGER,
          sha256              TEXT,
          remote_recording_id TEXT,
          created_at          INTEGER NOT NULL
        );

        INSERT INTO recordings_v5 (
          id, device_id, channel_id, recording_type, event_type,
          start_time, end_time, duration_ms, sample_rate,
          audio_format, container_format, relative_path, file_size, sha256,
          remote_recording_id, created_at
        )
        SELECT
          id, device_id, channel_id, recording_type, event_type,
          start_time, end_time, duration_ms, sample_rate,
          CASE WHEN event_type IN ('video_mp4', 'alarm_linked_mp4') THEN NULL
               ELSE audio_format END,
          CASE WHEN event_type IN ('video_mp4', 'alarm_linked_mp4') THEN 'mp4'
               ELSE audio_format END,
          relative_path, file_size, sha256, remote_recording_id, created_at
        FROM recordings;

        DROP TABLE recordings;
        ALTER TABLE recordings_v5 RENAME TO recordings;

        CREATE INDEX IF NOT EXISTS idx_recordings_time ON recordings (start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_recordings_device_time
          ON recordings (device_id, start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_recordings_type
          ON recordings (recording_type, start_time DESC);
        -- Device-library mirrors are keyed by the firmware's own record id.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_remote
          ON recordings (device_id, remote_recording_id)
          WHERE remote_recording_id IS NOT NULL;
      `)
    }
  },
  {
    version: 6,
    name: 'alarm-severity-and-note',
    up: (db) => {
      /**
       * Two facts about an alarm that the UI needs and the row could not carry:
       * a severity, and an operator's note.
       *
       * WHY `severity` IS SNAPSHOTTED HERE RATHER THAN DERIVED ON READ
       * The classification is CONFIGURABLE (which alarm type is which level), so
       * deriving it at read time would silently rewrite history every time someone
       * edited the mapping: yesterday's "critical" would become today's "info" and the
       * exported incident report would no longer match what the operator saw. The
       * level is therefore decided once, when the alarm is raised, and stored.
       *
       * WHY THE DEFAULT IS `'unknown'` AND NOT NULL
       * `unknown` is already a legal value in the domain vocabulary
       * (`EventSeverity` in `shared/domain/event-center.ts`), and it is the honest
       * value for every row that already exists here: those alarms were never
       * classified by anything. NULL would introduce a second way to say "we do not
       * know", and every reader would then have to handle both. `unknown` is NOT a
       * fallback — the camera's `alarm_level` is unusable (its read-side enum is
       * 0-3 while its write-side is 1-4, and the real device has never returned the
       * field) and the acoustic box has no level field at all, so "unknown" is the
       * correct answer for a large part of this table, not a placeholder.
       *
       * NOTE: iVMS-4200 has no severity concept whatsoever — its manual's 13 alarm
       * tables and its alarm list carry no level field. This column is OUR design,
       * not something copied from the reference product.
       *
       * The CHECK keeps a typo failing loudly at write time, the same reasoning as
       * the device `kind`, user `role` and recording container CHECKs.
       *
       * `note` mirrors the Note column the iVMS alarm list offers (manual UD02161B
       * p95, operator-entered free text). NULL means "no note", which is different
       * from an empty note and is what an untouched row should say. The 500-character
       * cap is OURS, not the manual's: the manual does not state a limit, and the cap
       * exists only so a rogue paste cannot bloat every list row. It is not a
       * statement about what a note may contain.
       */
      db.exec(`
        ALTER TABLE alarms ADD COLUMN severity TEXT NOT NULL DEFAULT 'unknown'
          CHECK (severity IN ('info', 'warning', 'critical', 'unknown'));

        ALTER TABLE alarms ADD COLUMN note TEXT
          CHECK (note IS NULL OR length(note) <= 500);

        -- The alarm list sorts by time and filters by severity, so the index mirrors
        -- the existing (device, time) / (acknowledged, time) pair.
        CREATE INDEX IF NOT EXISTS idx_alarms_severity_time
          ON alarms (severity, alarm_time DESC);
      `)
    }
  },
  {
    version: 7,
    name: 'sample-library',
    up: (db) => {
      /**
       * LOCAL ABNORMAL-VOICEPRINT SAMPLE LIBRARY (owner request 2026-09-16).
       *
       * One row = one training sample: where its audio came from, what it sounds like
       * numerically, and — the part that matters most — WHO SAYS WHICH CLASS IT IS.
       *
       * WHY `label_source` IS A COLUMN AND NOT A CONVENTION
       * The three sources have completely different trust levels: the DEVICE's own
       * verdict (`dauAbnoType` bits on FA8, an `alarm_reasons` string on the
       * auscultation family), a HUMAN's annotation (the only ground truth), and an
       * AI/model SUGGESTION (a candidate awaiting review). If they are mixed without
       * provenance the resulting dataset cannot be audited afterwards, and a model
       * trained on it will confidently reproduce the device's guessing while the
       * report claims human-quality labels. So the column is NOT NULL-able in
       * practice (NULL exactly when `label` is NULL) and is enforced by a CHECK.
       *
       * WHY `label` IS FREE TEXT, NOT AN ENUM
       * The two device families do not share a vocabulary: FA8 has the 14-bit taxonomy
       * (confirmed bit-by-bit by its API manual), while the auscultation family sends
       * free-text reasons such as "时域能量比超限，" and its manual does not enumerate
       * them (see docs/Ivms4200-UX-REFERENCE.md §15.23.3). Forcing one enum would mean
       * inventing slots for categories we cannot name. Values are stable identifiers
       * (`corona_discharge`) or the device's own text — never translated UI copy.
       *
       * WHY `features` IS JSON TEXT
       * The feature vector has 7 dimensions today (the FA8 `/features_stream` set) and
       * will grow. A JSON blob keeps a sample readable by an older build instead of
       * failing to open the database. Missing dimensions stay MISSING (absent keys),
       * never 0 — see `shared/domain/sample-library.ts`.
       *
       * `recording_id` CASCADEs: a sample's audio lives in the source recording, so
       * deleting that recording must not leave a sample pointing at a file that no
       * longer exists. Imported samples (no local recording row) carry `relative_path`
       * themselves and leave `recording_id` NULL.
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS samples (
          id              TEXT PRIMARY KEY,
          recording_id    TEXT REFERENCES recordings (id) ON DELETE CASCADE,
          device_id       TEXT NOT NULL,
          channel_id      INTEGER NOT NULL,
          source          TEXT NOT NULL
                          CHECK (source IN ('alarm', 'manual', 'import')),
          captured_at     INTEGER NOT NULL,
          duration_ms     INTEGER,
          sample_rate     INTEGER,
          relative_path   TEXT,
          sha256          TEXT,
          label           TEXT,
          label_source    TEXT
                          CHECK (label_source IS NULL OR label_source IN ('device', 'human', 'ai')),
          features        TEXT,
          created_at      INTEGER NOT NULL,
          -- 标签与来源要么都有、要么都没有：只有一半的行是"说不清标签是谁给的"。
          --
          -- 这条是**表级**约束，必须写在所有列定义**之后** —— SQLite 的语法里表级约束只能
          -- 跟在列定义列表末尾，插在中间会得到 near "features": syntax error
          --（第一版就是这么写的，被 tests/sample-repository.test.ts 当场抓住）。
          -- 注意：这段 SQL 在一个 JS 模板字面量里，所以这里**不能出现反引号** ——
          -- 第一版把测试文件名用反引号括起来，直接把模板提前闭合了（TS1005 一串）。
          CHECK ((label IS NULL) = (label_source IS NULL))
        );

        -- The dataset view groups and filters by label; the training set is built by
        -- label, so this index mirrors the query that actually runs.
        CREATE INDEX IF NOT EXISTS idx_samples_label
          ON samples (label, captured_at DESC);
        -- "which samples came from this recording" (cascade checks + the library UI).
        CREATE INDEX IF NOT EXISTS idx_samples_recording
          ON samples (recording_id);
        CREATE INDEX IF NOT EXISTS idx_samples_device_time
          ON samples (device_id, captured_at DESC);
        -- Provenance filtering ("show me only human-labelled samples").
        CREATE INDEX IF NOT EXISTS idx_samples_label_source
          ON samples (label_source, captured_at DESC);
      `)
    }
  },
  {
    version: 8,
    name: 'sample-label-dimensions',
    up: (db) => {
      /**
       * TWO LABEL DIMENSIONS + A MAINTAINED VOCABULARY (owner request 2026-09-16, second round).
       *
       * The owner asked for what the domain file already argues for: a sample carries an
       * EQUIPMENT type and a FAULT type, they are maintained as two vocabularies, and
       * labelling means picking from those lists (or adding to them on the spot).
       *
       * WHY A TABLE REBUILD AND NOT `ALTER TABLE ... RENAME COLUMN`
       * `label`/`label_source` are the FAULT dimension and keep their meaning; a rename would
       * be enough for them, but the EQUIPMENT pair has to be added anyway AND the table
       * carries a cross-column CHECK. SQLite can rename columns in a CHECK, but it cannot
       * ADD one, so a rebuild is the only way to end up with both CHECKs. The rebuild is
       * cheap and the samples table is small by construction (a library of a few thousand
       * rows), and copying `label -> fault_label` keeps every existing row's meaning.
       *
       * Nothing references `samples`, so dropping it cannot break another table's FK; the
       * FK that `samples` itself owns (-> recordings, CASCADE) is re-declared identically.
       *
       * WHY THE VOCABULARY IS A TABLE AND NOT A JSON SETTING
       * The lists are used for (a) the pickers, (b) the "how many samples use this" count and
       * (c) a uniqueness rule that must survive concurrent edits. All three are queries, and
       * `UNIQUE (dimension, name_key)` is what actually stops `轴承故障` and `轴承故障 ` from
       * becoming two classes. A JSON blob in `app_meta` would need all of that re-implemented
       * in JS, including the race.
       *
       * NOTE (same trap as v7, recorded there): this SQL lives inside a JS template literal,
       * so it must not contain a backtick, and table-level CHECKs must come after all columns.
       */
      db.exec(`
        CREATE TABLE samples_v8 (
          id                    TEXT PRIMARY KEY,
          recording_id          TEXT REFERENCES recordings (id) ON DELETE CASCADE,
          device_id             TEXT NOT NULL,
          channel_id            INTEGER NOT NULL,
          source                TEXT NOT NULL
                                CHECK (source IN ('alarm', 'manual', 'import')),
          captured_at           INTEGER NOT NULL,
          duration_ms           INTEGER,
          sample_rate           INTEGER,
          relative_path         TEXT,
          sha256                TEXT,
          -- 故障类型（v7 的 label/label_source）：设备位图给的是这一维的弱标签。
          fault_label           TEXT,
          fault_label_source    TEXT
                                CHECK (fault_label_source IS NULL OR fault_label_source IN ('device', 'human', 'ai')),
          -- 设备类型（v8 新增）：设备从不告诉我们它装在什么设备上，所以只可能来自人工或 AI。
          equipment_label       TEXT,
          equipment_label_source TEXT
                                CHECK (equipment_label_source IS NULL OR equipment_label_source IN ('device', 'human', 'ai')),
          features              TEXT,
          created_at            INTEGER NOT NULL,
          CHECK ((fault_label IS NULL) = (fault_label_source IS NULL)),
          CHECK ((equipment_label IS NULL) = (equipment_label_source IS NULL))
        );

        INSERT INTO samples_v8 (
          id, recording_id, device_id, channel_id, source, captured_at,
          duration_ms, sample_rate, relative_path, sha256,
          fault_label, fault_label_source, equipment_label, equipment_label_source,
          features, created_at
        )
        SELECT
          id, recording_id, device_id, channel_id, source, captured_at,
          duration_ms, sample_rate, relative_path, sha256,
          label, label_source, NULL, NULL,
          features, created_at
        FROM samples;

        DROP TABLE samples;
        ALTER TABLE samples_v8 RENAME TO samples;

        CREATE INDEX IF NOT EXISTS idx_samples_fault_label
          ON samples (fault_label, captured_at DESC);
        CREATE INDEX IF NOT EXISTS idx_samples_equipment_label
          ON samples (equipment_label, captured_at DESC);
        CREATE INDEX IF NOT EXISTS idx_samples_recording
          ON samples (recording_id);
        CREATE INDEX IF NOT EXISTS idx_samples_device_time
          ON samples (device_id, captured_at DESC);
        CREATE INDEX IF NOT EXISTS idx_samples_fault_source
          ON samples (fault_label_source, captured_at DESC);

        -- 标签库：两个维度共用一张表（dimension 区分），因为它们的**行为**完全一样。
        -- 分成两张表会让"重命名 / 删除 / 统计引用数"这三件事各写两遍。
        CREATE TABLE IF NOT EXISTS sample_labels (
          id          TEXT PRIMARY KEY,
          dimension   TEXT NOT NULL CHECK (dimension IN ('equipment', 'fault')),
          name        TEXT NOT NULL,
          name_key    TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          UNIQUE (dimension, name_key)
        );

        CREATE INDEX IF NOT EXISTS idx_sample_labels_dimension
          ON sample_labels (dimension, name_key);
      `)
    }
  },
  {
    version: 9,
    name: 'alarm-device-payload',
    up: (db) => {
      /**
       * ALARM ROWS FROM A SECOND PROTOCOL (owner request 2026-09-16, third item: the E2 "pull" channel).
       *
       * Until now every alarm row came from the FA8 family, whose `alarm_mask` is a 14-bit
       * fault bitmap that this app decodes, classifies and scores. The auscultation family
       * (E2 / FA100 / FA110) reports something **different**: an `alarm_value` that the manual
       * describes as "a hexadecimal number where each digit is a key value" with only SIX
       * values documented, plus a free-text `alarm_reasons`.
       *
       * The two are NOT the same vocabulary. Writing an E2 `alarm_value` into `alarm_mask`
       * would make `decodeAlarmMask()` produce FA8 fault types that the device never reported,
       * and `deriveAlarmSeverity()` would then assign a severity from those invented bits —
       * a fabricated critical/warning level on a real alarm. So the raw device numbers get
       * their own columns and `alarm_mask` stays 0 for these rows.
       *
       * `source` is the honest label for "which protocol produced this row". It is nullable for
       * backward compatibility with rows written before this migration (they are all FA8-era,
       * hence the backfill) — but every new write sets it explicitly.
       *
       * `device_raw` keeps the whole device payload as JSON: the E2 modes return different
       * feature sets (`tde_ratio`, `fde_ratio`, `hpss`, `sc_ratio`, `oeh_ratio`…), and inventing
       * a column per key would both bloat the schema and freeze a shape the firmware is free to
       * change. The columns are for the fields the UI filters on; JSON is for the rest.
       *
       * `files_status` is the E2 "is the file still on the device" flag (0 = deleted by the
       * 5000-record retention rule). It is NULL for FA8 rows, which have no such notion —
       * NULL means "this protocol does not report it", never "the file is gone".
       */
      db.exec(`
        ALTER TABLE alarms ADD COLUMN source TEXT
          CHECK (source IS NULL OR source IN ('fa8', 'e2'));
        ALTER TABLE alarms ADD COLUMN device_alarm_value INTEGER;
        ALTER TABLE alarms ADD COLUMN device_reason TEXT;
        ALTER TABLE alarms ADD COLUMN files_status INTEGER
          CHECK (files_status IS NULL OR files_status IN (0, 1));
        ALTER TABLE alarms ADD COLUMN device_raw TEXT;

        UPDATE alarms SET source = 'fa8' WHERE source IS NULL;

        CREATE INDEX IF NOT EXISTS idx_alarms_source_time
          ON alarms (source, alarm_time DESC);
      `)
    }
  },
  {
    version: 10,
    name: 'device-kind-auscultation',
    foreignKeysOff: true,
    up: (db) => {
      /**
       * 第三种机型：听诊盒子族（E2 / FA100 / FA110 / Air Sonar）。
       *
       * v3 给 `devices.kind` 加的是一条**列级 CHECK**：`kind IN ('acousticBox','acousticCamera')`。
       * 于是代码里加了第三种机型、探活也认得出它，**但写库那一刻会被 CHECK 拒绝**
       * （`SQLITE_CONSTRAINT`）—— 表现是"添加设备失败"，而排查方向会被引向协议。
       * 这个缺陷是 `tests/e2-device.test.ts` 抓到的（它用真的 `DeviceService` 走了一遍 add）。
       *
       * SQLite 改不了 CHECK，只能重建表。重建一张**被四张表引用**的父表有一个必须处理的坑：
       * 外键打开时 `DROP TABLE devices` 会先做一次隐式 DELETE，而 channels / alarms /
       * recordings / samples 全是 `ON DELETE CASCADE` —— 那会把现场数据**全部删掉**。
       * 所以这一条迁移标了 `foreignKeysOff: true`，由迁移器在事务外面切 PRAGMA，
       * 并在之后跑一次 `PRAGMA foreign_key_check` 确认没有弄坏引用。
       *
       * 其余列**逐字照抄** v1 的定义（含 CHECK 与默认值）：重建的规矩是"除了要改的那一处，
       * 别的都不动"。少抄一条 CHECK 就等于悄悄放宽了一条约束。
       */
      db.exec(`
        CREATE TABLE devices_v10 (
          id               TEXT PRIMARY KEY,
          device_uid       TEXT NOT NULL,
          name             TEXT NOT NULL,
          ip_address       TEXT,
          http_port        INTEGER,
          mac_address      TEXT,
          connection_type  TEXT NOT NULL DEFAULT 'LAN'
                             CHECK (connection_type IN ('LAN', 'REMOTE')),
          firmware_version TEXT,
          fpga_version     TEXT,
          web_version      TEXT,
          status           TEXT NOT NULL DEFAULT 'UNKNOWN'
                             CHECK (status IN ('ONLINE', 'OFFLINE', 'UNKNOWN')),
          last_seen        INTEGER,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          auth_strategy    TEXT,
          kind             TEXT NOT NULL DEFAULT 'acousticBox'
                             CHECK (kind IN ('acousticBox', 'acousticCamera', 'auscultationBox'))
        );

        INSERT INTO devices_v10 (
          id, device_uid, name, ip_address, http_port, mac_address, connection_type,
          firmware_version, fpga_version, web_version, status, last_seen,
          created_at, updated_at, auth_strategy, kind
        )
        SELECT
          id, device_uid, name, ip_address, http_port, mac_address, connection_type,
          firmware_version, fpga_version, web_version, status, last_seen,
          created_at, updated_at, auth_strategy, kind
        FROM devices;

        DROP TABLE devices;
        ALTER TABLE devices_v10 RENAME TO devices;

        -- **UNIQUE** 不能少：v1 那条就是唯一的，"IP 改变不生成重复设备"靠它兜底。
        -- 重建时把索引写松一格（少写 UNIQUE）会静默放宽一条约束，而没有任何报错。
        CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_uid ON devices (device_uid);
        CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status);
      `)
    }
  },
  {
    version: 11,
    name: 'device-installation-info',
    up: (db) => {
      /**
       * 安装信息（业主 2026-09-17 第 1 条）：**声源定位设备**（Air Sonar / SN-16）要记
       * 「点位（GIS 经纬度）」「朝向（方位角）」「基准分贝值」。
       *
       * 为什么不放在设置表的 JSON 里：这三项是**每一台设备**的属性（同一套软件里可以有多台
       * 声呐，各自装在不同的点位、朝不同的方向），查询与列表都要按设备读它。
       *
       * 三处**我们自己定的**（手册没有"GIS/方位角/分贝"这套字段，这是我们的数据模型）：
       *   1. 经纬度用 **WGS84 十进制度**（不是度分秒、不是投影坐标）：设备的 `/system` 里
       *      没有位置字段，只能人工录入，而十进制度是地图/GIS 工具之间最通用的交换形式；
       *   2. 方位角 `azimuth_deg` 约定 **0=正北、顺时针为正、范围 [0,360)**（罗盘方位角，
       *      与 SN-16 的 `horizontal` 声源方位同向）—— 同一台设备上两个方位角必须可比；
       *   3. `sound_level_db` 是**该点位的基准声压级**（dB SPL），用来把设备报的
       *      `db_value` 与现场基准对照；它**不是**告警门限（门限在设备的 `db_limit` 里）。
       *
       * 四列都可空：其他机型（声纹设备/相机）留空，界面显示"—"。CHECK 约束这里不加：
       * SQLite 的 `ALTER TABLE ADD COLUMN` 允许 CHECK，但一条写错的 CHECK 会让"以后补录"
       * 直接写不进去，而范围校验放在服务层与界面上更可控（有单测钉住）。
       */
      db.exec(`
        ALTER TABLE devices ADD COLUMN gis_latitude REAL;
        ALTER TABLE devices ADD COLUMN gis_longitude REAL;
        ALTER TABLE devices ADD COLUMN azimuth_deg REAL;
        ALTER TABLE devices ADD COLUMN sound_level_db REAL;
      `)
    }
  },
  {
    version: 12,
    name: 'e2-variant-and-alarm-snapshots',
    up: (db) => {
      /**
       * 两列，各自解决一件**读不到东西**的事（业主 2026-09-17 第 8 批）。
       *
       * 1) `devices.e2_variant` —— 听诊盒子族**有两代协议**（2023 版听诊盒子 / SN-16 空气声呐），
       *    判据是设备 `/system` 的回话内容（`detectE2Variant()`），**不按型号名猜**。
       *    在此之前变体只活在"这一次读到的客户端对象"里：刷新页面、重启软件、换一个页面读设备，
       *    就又要问一次设备才知道 —— 而它决定的是**这一族给不给 PTZ 配置页**
       *    （空气声呐与球机联动，2023 版没有这个概念），界面必须能同步地知道答案。
       *    所以把"设备自己说的变体"记在设备行上：写它的是读到 `/system` 的那条路，
       *    每次写完**读回核对**（业主的硬规矩）。
       *
       *    不加 CHECK：取值由 `isE2Variant()` 在代码里收窄，而一条写错的 CHECK 会让
       *    "以后多一代协议"直接写不进去（v10 的教训：改 CHECK 要重建父表）。
       *    `NULL` = 还没读到过（不是"2023 版"）：把未知写成某一代会凭空造出一个答案。
       *
       * 2) `alarms.snapshot_dir` —— 告警的**抓图**（SN-16 是 3 张球机抓图 `1.jpg`…`3.jpg`）
       *    早在 `E2SyncService.pullSpectrograms()` 里就下载了，但**路径没有落进任何一列**，
       *    于是界面永远找不到它们（业主这次要的正是"点声呐看截图"）。
       *    存**存储根相对**的目录（与 `recordings.relative_path` 同一条规矩），
       *    这样换存储根目录时它仍然有效。
       *
       *    `NULL` = 这条告警没有图（设备上本来就没有 / 没下过）—— 与"有目录但文件被删了"
       *    是两件事，界面分开说。
       */
      db.exec(`
        ALTER TABLE devices ADD COLUMN e2_variant TEXT;
        ALTER TABLE alarms ADD COLUMN snapshot_dir TEXT;
      `)
    }
  },
  {
    version: 13,
    name: 'event-status-and-activity',
    up: (db) => {
      /**
       * 事件中心的**处置工作流**（规格 §2.2 的状态机 + §13.3 的 Activity）。
       *
       * WHY TWO NEW TABLES RATHER THAN COLUMNS ON `alarms`
       * 一条事件有三个所有者：声纹告警在 `alarms`（SQLite）、本机联动在引擎的待处理列表
       * （内存 + 它自己的存储）、相机检测日志在**设备**上（我们连写接口都没有）。
       * 状态与 Activity 是**我们自己的处置记录**，三个来源一视同仁，所以按
       * `EventCenterEntry.id`（稳定标识，`detect:` / `linkage:` / `alarm:` 前缀）单独存：
       *
       *   - 不用改 `alarms` 的语义：那一行的 `acknowledged` 仍然是**来源侧的事实**，
       *     而工作流状态是本机判断，两者可以不一致（`docs/EVENT-CENTER.md` §3.12 写了取舍）；
       *   - 不用碰联动引擎的内部存储（它归那个模块所有）；
       *   - 相机检测日志也能被处置（记录在本机），而不是因为"设备没有接口"就整条不能动。
       *
       * `event_status` 一行 = 一条事件当前的工作流状态；`event_activity` 是它的流水。
       * 两者在**同一个事务**里写（仓储层负责），所以不会出现"状态变了但没记录"。
       *
       * CHECK 用规格的七个取值（`EVENT_STATUSES`）。这里是**新表**，将来要加取值可以重建，
       * 不像 `alarms.severity` 那样牵着父表与索引（v10 的教训）。
       *
       * `event_activity` 会一直长：现在没有保留策略（我们自己的审计流水，删掉就没有证据了）。
       * 真要限制得先定"多久算旧账"，那是产品决定；这一轮**不删**，如实记在文档里。
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_status (
          entry_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (
            status IN ('new', 'acknowledged', 'investigating', 'resolved', 'closed', 'muted', 'reopened')
          ),
          assignee TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS event_activity (
          id TEXT PRIMARY KEY,
          entry_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('status', 'assign', 'note')),
          from_status TEXT,
          to_status TEXT,
          assignee TEXT,
          note TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_event_activity_entry ON event_activity (entry_id, at);
      `)
    }
  },
  {
    version: 14,
    name: 'incidents-and-links',
    up: (db) => {
      /**
       * Incident（规格 §2.1 / §13.2 / §14.2）：一个现实世界的问题，关联**多条** Alert。
       *
       * WHY THE TITLE IS THE ONLY USER-AUTHORED FIELD
       * 规格 §14.2 的 V1 只要求「人工 Create Incident + 手动关联 Alert」——它**没有**给
       * Incident 定义状态机、严重度、负责人或关闭条件（§2.2 的状态机是给 Alert 的）。
       * 所以我们**不造**那套生命周期：表里只有标题、可选备注、创建人与时间。将来规格
       * 给了再迁移（这是 `docs/EVENT-CENTER.md` §3.16 记下的取舍）。
       *
       * WHY LINKS ARE THEIR OWN TABLE KEYED BY `EventCenterEntry.id`
       * 一条 Alert 在库里是三个来源之一（声纹告警 `alarms`、本机联动、设备上的检测日志），
       * 而"它属于哪个 Incident"是**我们自己的关联**，与状态/Activity 同一套标识空间
       * （`alarm:` / `linkage:` / `detect:` 前缀）。所以 `incident_alerts.entry_id` 与
       * `event_status.entry_id` 是同一个 key：一条事件的状态、流水、所属 Incident 可以
       * 用一次查询对齐。这也是**手动关联**（V1）唯一说得通的存法。
       *
       * 主键 `(incident_id, entry_id)`：同一条 Alert 不会被同一个 Incident 收两次
       * （界面上的"关联"按钮点两次不该产生两条链接）。
       *
       * 外键 `ON DELETE CASCADE`：删掉一个 Incident 时它的链接必须一起走。这一轮还没有
       * 删除 Incident 的入口，但允许悬空链接的表迟早会在某次删除里留下垃圾。
       *
       * `idx_incident_alerts_entry`：详情页问的是"**这一条** Alert 属于哪些 Incident"，
       * 没有它每次都要全表扫链接表。
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          note TEXT,
          created_at INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS incident_alerts (
          incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          linked_at INTEGER NOT NULL,
          linked_by TEXT NOT NULL,
          PRIMARY KEY (incident_id, entry_id)
        );

        CREATE INDEX IF NOT EXISTS idx_incident_alerts_entry ON incident_alerts (entry_id);
      `)
    }
  },
  {
    version: 15,
    name: 'device-push-secret',
    up: (db) => {
      /**
       * 设备推流秘钥（业主 2026-09-19 第 1 条：「HTTP 推流和 MQTT 是类似于 thingsboard 平台接
       * IOT 设备的逻辑」）。
       *
       * WHY A COLUMN ON `devices` AND NOT A TABLE OF ITS OWN
       * 秘钥是**这台设备的事实**（与它的地址、机型同一个主语），生命周期也完全一致：删掉设备
       * 就该一并消失。单开一张表意味着要自己维护这个级联，而 `devices` 的主键已经被四张表
       * 用 `ON DELETE CASCADE` 引着 —— 多一张表只多一处可能忘记加外键的地方。
       *
       * WHY UNIQUE
       * 两台设备共用一条秘钥，收到数据时"这条是谁的"就没有答案，而错误答案的表现是
       * **数据写进了另一台设备**（比拒绝写入严重得多）。索引允许 NULL（多条 `NULL` 不冲突），
       * 所以"这台设备还没生成过秘钥"与"两台设备用了同一条"是两件互不干扰的事。
       *
       * 口径（32 位小写十六进制、可轮换、只允许写入遥测）见 `@shared/domain/iot-ingest`。
       */
      db.exec(`
        ALTER TABLE devices ADD COLUMN push_secret TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_push_secret ON devices (push_secret);
      `)
    }
  }
]

export interface OpenDatabaseOptions {
  /** Absolute path to the .db file, or ':memory:' for tests. */
  file: string
  /** When true, emit every statement to the provided logger. */
  verbose?: (message: string) => void
}

/**
 * Open (creating if needed) the metadata database and bring it up to
 * SCHEMA_VERSION. Safe to call repeatedly.
 */
export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const db = new Database(options.file)
  applyPragmas(db)
  if (options.verbose) db.function('noop', () => null)
  runMigrations(db)
  return db
}

/**
 * Pragmas chosen for a desktop app that must survive an abrupt power loss
 * without corrupting metadata:
 *   WAL          - readers never block the writer; essential once the UI polls
 *   synchronous  - NORMAL is the right durability/perf point for WAL
 *   foreign_keys - the CASCADE rules above must actually fire
 *   busy_timeout - absorb brief contention instead of throwing SQLITE_BUSY
 */
function applyPragmas(db: SqliteDatabase): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')
}

/** Apply any migrations the file has not seen yet, inside one transaction each. */
export function runMigrations(db: SqliteDatabase): number {
  const current = db.pragma('user_version', { simple: true }) as number
  let version = current

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue

    /**
     * 重建被引用的表时必须**在事务外面**关掉外键强制：`PRAGMA foreign_keys` 在事务内部
     * 是空操作，而在外键打开时 `DROP TABLE devices` 会先做一次隐式 DELETE，
     * 把 channels / alarms / recordings / samples 全部级联删掉（见 `Migration.foreignKeysOff`）。
     */
    const disableForeignKeys = migration.foreignKeysOff === true
    if (disableForeignKeys) db.pragma('foreign_keys = OFF')
    try {
      const apply = db.transaction(() => {
        migration.up(db)
        db.pragma(`user_version = ${migration.version}`)
      })
      apply()
    } finally {
      if (disableForeignKeys) db.pragma('foreign_keys = ON')
    }

    if (disableForeignKeys) {
      /**
       * 重建之后**核对一遍引用完整性**：关着外键跑完就打开，等于把"有没有把关系弄坏"这件事
       * 留给了下一个 500 行的排查。`foreign_key_check` 是空的才算过；有孤儿行就抛出去，
       * 让升级在那一刻失败，而不是带着坏数据继续跑。
       */
      const violations = db.pragma('foreign_key_check') as unknown[]
      if (violations.length > 0) {
        throw new Error(
          `迁移 ${migration.version} (${migration.name}) 之后仍有 ${violations.length} 条外键引用不完整`
        )
      }
    }

    version = migration.version
  }

  return version
}

/** Convenience: is this handle usable? Guards against a closed DB on app exit. */
export function isOpen(db: SqliteDatabase): boolean {
  try {
    return db.open
  } catch {
    return false
  }
}
