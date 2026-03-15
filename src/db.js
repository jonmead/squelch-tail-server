'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

/**
 * Open (or create) the SQLite database and ensure the schema is up to date.
 *
 * All field names mirror trunk-recorder's JSON output exactly so the mapping
 * is unambiguous.  See call_concluder/call_concluder.cc: create_call_json().
 */
function openDb(dbPath) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        -- ── Systems ────────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS systems (
            id    INTEGER PRIMARY KEY,   -- numeric system ID supplied at upload
            label TEXT    NOT NULL DEFAULT ''  -- short_name from TR
        );

        -- ── Talkgroups ─────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS talkgroups (
            system_id         INTEGER NOT NULL,
            id                INTEGER NOT NULL,
            label             TEXT,   -- talkgroup_tag        (alpha tag)
            name              TEXT,   -- talkgroup_description
            group_name        TEXT,   -- talkgroup_group
            group_tag         TEXT,   -- talkgroup_group_tag
            PRIMARY KEY (system_id, id)
        );

        -- ── Calls ──────────────────────────────────────────────────────────────
        -- Every column maps 1-to-1 to a trunk-recorder JSON field unless noted.
        CREATE TABLE IF NOT EXISTS calls (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Timing (use start_time_ms as the canonical sort key)
            start_time_ms   INTEGER NOT NULL,  -- ms-precision; falls back to start_time*1000
            stop_time_ms    INTEGER,
            call_length_ms  INTEGER,           -- call_length_ms from TR

            -- System + talkgroup (foreign-key style, but no FK constraint)
            system_id       INTEGER NOT NULL,
            talkgroup_id    INTEGER,

            -- RF
            freq            INTEGER,           -- Hz
            freq_error      INTEGER,
            signal          INTEGER,           -- dBm
            noise           INTEGER,           -- dBm

            -- Recorder
            source_num      INTEGER,
            recorder_num    INTEGER,
            tdma_slot       INTEGER,
            phase2_tdma     INTEGER,           -- 0/1
            color_code      INTEGER,

            -- Call attributes
            audio_type      TEXT,              -- "digital" | "analog"
            audio_path      TEXT,              -- relative path to stored audio file
            priority        INTEGER,
            mode            INTEGER,
            duplex          INTEGER,           -- 0/1
            emergency       INTEGER DEFAULT 0, -- 0/1
            encrypted       INTEGER DEFAULT 0, -- 0/1

            -- Raw JSON arrays from TR (stored verbatim for full fidelity)
            freq_list       TEXT,              -- freqList  [{freq,time,pos,len,error_count,spike_count}]
            src_list        TEXT,              -- srcList   [{src,time,pos,emergency,signal_system,tag}]
            patched_tgs     TEXT               -- patched_talkgroups [id, ...]
        );

        CREATE INDEX IF NOT EXISTS idx_calls_start   ON calls(start_time_ms);
        CREATE INDEX IF NOT EXISTS idx_calls_system  ON calls(system_id, talkgroup_id);
        CREATE INDEX IF NOT EXISTS idx_calls_tg      ON calls(talkgroup_id);
        CREATE INDEX IF NOT EXISTS idx_calls_emerg   ON calls(emergency) WHERE emergency = 1;

        -- ── Call units ─────────────────────────────────────────────────────────
        -- One row per (call, unit) keyed-up event; enables efficient unit queries.
        CREATE TABLE IF NOT EXISTS call_units (
            call_id       INTEGER NOT NULL,
            unit_id       INTEGER NOT NULL,  -- src
            unit_tag      TEXT,              -- tag (alias if configured in TR)
            signal_system TEXT,             -- signal_system (e.g. "SYSNAME" for cross-patches)
            tx_time_ms    INTEGER,           -- time (seconds) * 1000
            pos           REAL,             -- position in recording (seconds)
            emergency     INTEGER DEFAULT 0,
            PRIMARY KEY (call_id, unit_id, tx_time_ms)
        );

        CREATE INDEX IF NOT EXISTS idx_call_units_unit ON call_units(unit_id);
    `);

    return db;
}

// ── Write helpers ─────────────────────────────────────────────────────────────

function upsertSystem(db, id, label) {
    db.prepare(`
        INSERT INTO systems (id, label) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET label = excluded.label WHERE excluded.label != ''
    `).run(id, label || '');
}

function upsertTalkgroup(db, systemId, tg) {
    db.prepare(`
        INSERT INTO talkgroups (system_id, id, label, name, group_name, group_tag)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(system_id, id) DO UPDATE SET
            label      = coalesce(nullif(excluded.label,      ''), talkgroups.label),
            name       = coalesce(nullif(excluded.name,       ''), talkgroups.name),
            group_name = coalesce(nullif(excluded.group_name, ''), talkgroups.group_name),
            group_tag  = coalesce(nullif(excluded.group_tag,  ''), talkgroups.group_tag)
    `).run(systemId, tg.id, tg.label || '', tg.name || '', tg.groupName || '', tg.groupTag || '');
}

/**
 * Insert a call and its per-unit transmission rows atomically.
 *
 * @param {object} db
 * @param {object} call  — keys mirror TR JSON (camelCased where needed)
 * @returns {number}     — new call id
 */
function insertCall(db, call) {
    const insertCallStmt = db.prepare(`
        INSERT INTO calls (
            start_time_ms, stop_time_ms, call_length_ms,
            system_id, talkgroup_id,
            freq, freq_error, signal, noise,
            source_num, recorder_num, tdma_slot, phase2_tdma, color_code,
            audio_type, audio_path,
            priority, mode, duplex, emergency, encrypted,
            freq_list, src_list, patched_tgs
        ) VALUES (
            ?, ?, ?,
            ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?
        )
    `);

    const insertUnitStmt = db.prepare(`
        INSERT OR IGNORE INTO call_units
            (call_id, unit_id, unit_tag, signal_system, tx_time_ms, pos, emergency)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    return db.transaction(() => {
        const { lastInsertRowid: callId } = insertCallStmt.run(
            call.startTimeMs,
            call.stopTimeMs    ?? null,
            call.callLengthMs  ?? null,
            call.systemId,
            call.talkgroupId   ?? null,
            call.freq          ?? null,
            call.freqError     ?? null,
            call.signal        ?? null,
            call.noise         ?? null,
            call.sourceNum     ?? null,
            call.recorderNum   ?? null,
            call.tdmaSlot      ?? null,
            call.phase2Tdma    ?? null,
            call.colorCode     ?? null,
            call.audioType     ?? null,
            call.audioPath     ?? null,
            call.priority      ?? null,
            call.mode          ?? null,
            call.duplex        ?? null,
            call.emergency     ? 1 : 0,
            call.encrypted     ? 1 : 0,
            call.freqList      ? JSON.stringify(call.freqList)    : null,
            call.srcList       ? JSON.stringify(call.srcList)     : null,
            call.patchedTgs    ? JSON.stringify(call.patchedTgs)  : null,
        );

        if (Array.isArray(call.srcList)) {
            for (const src of call.srcList) {
                const unitId = parseInt(src.src, 10);
                if (isNaN(unitId)) continue;
                insertUnitStmt.run(
                    callId,
                    unitId,
                    src.tag           || null,
                    src.signal_system || null,
                    src.time != null  ? Math.round(src.time * 1000) : null,
                    src.pos  ?? null,
                    src.emergency ? 1 : 0,
                );
            }
        }

        return callId;
    })();
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/**
 * Query calls with optional filters.
 *
 * Filters: systemId, talkgroupId, unitId, before (ms), after (ms),
 *          emergency (bool), encrypted (bool), limit, offset
 */
function queryCalls(db, filters = {}) {
    const { systemId, talkgroupId, unitId, before, after,
            emergency, encrypted, limit = 50, offset = 0 } = filters;

    const conds  = [];
    const params = [];

    if (systemId    != null) { conds.push('c.system_id = ?');    params.push(systemId); }
    if (talkgroupId != null) { conds.push('c.talkgroup_id = ?'); params.push(talkgroupId); }
    if (before      != null) { conds.push('c.start_time_ms < ?');  params.push(before); }
    if (after       != null) { conds.push('c.start_time_ms >= ?'); params.push(after); }
    if (emergency   != null) { conds.push('c.emergency = ?');    params.push(emergency ? 1 : 0); }
    if (encrypted   != null) { conds.push('c.encrypted = ?');    params.push(encrypted ? 1 : 0); }
    if (unitId      != null) {
        conds.push('EXISTS (SELECT 1 FROM call_units u WHERE u.call_id = c.id AND u.unit_id = ?)');
        params.push(unitId);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const total = db.prepare(`SELECT COUNT(*) AS n FROM calls c ${where}`).get(...params).n;

    const rows = db.prepare(`
        SELECT c.*,
               s.label AS system_label,
               t.label AS tg_label, t.name AS tg_name,
               t.group_name, t.group_tag
        FROM calls c
        LEFT JOIN systems    s ON s.id = c.system_id
        LEFT JOIN talkgroups t ON t.system_id = c.system_id AND t.id = c.talkgroup_id
        ${where}
        ORDER BY c.start_time_ms DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const calls = rows.map(rowToCall);
    attachUnits(db, calls);
    return { total, calls };
}

function getCall(db, id) {
    const row = db.prepare(`
        SELECT c.*,
               s.label AS system_label,
               t.label AS tg_label, t.name AS tg_name,
               t.group_name, t.group_tag
        FROM calls c
        LEFT JOIN systems    s ON s.id = c.system_id
        LEFT JOIN talkgroups t ON t.system_id = c.system_id AND t.id = c.talkgroup_id
        WHERE c.id = ?
    `).get(id);
    if (!row) return null;
    const call = rowToCall(row);
    attachUnits(db, [call]);
    return call;
}

function getSystems(db) {
    const systems    = db.prepare('SELECT id, label FROM systems ORDER BY id').all();
    const talkgroups = db.prepare(`
        SELECT system_id, id, label, name, group_name, group_tag
        FROM talkgroups ORDER BY system_id, id
    `).all();

    const tgMap = {};
    for (const tg of talkgroups) {
        (tgMap[tg.system_id] = tgMap[tg.system_id] || []).push({
            id: tg.id, label: tg.label, name: tg.name,
            groupName: tg.group_name, groupTag: tg.group_tag,
        });
    }
    return systems.map(s => ({ id: s.id, label: s.label, talkgroups: tgMap[s.id] || [] }));
}

function queryUnits(db, filters = {}) {
    const { systemId, limit = 100, offset = 0 } = filters;
    const where  = systemId != null ? 'WHERE c.system_id = ?' : '';
    const params = systemId != null ? [systemId] : [];

    return db.prepare(`
        SELECT u.unit_id,
               MAX(u.unit_tag)   AS tag,
               COUNT(*)          AS call_count,
               MAX(u.tx_time_ms) AS last_seen_ms
        FROM call_units u
        JOIN calls c ON c.id = u.call_id
        ${where}
        GROUP BY u.unit_id
        ORDER BY last_seen_ms DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset).map(r => ({
        unitId:    r.unit_id,
        tag:       r.tag || null,
        callCount: r.call_count,
        lastSeen:  r.last_seen_ms ? new Date(r.last_seen_ms).toISOString() : null,
    }));
}

function deleteOldCalls(db, retentionMs) {
    const cutoff = Date.now() - retentionMs;
    const rows   = db.prepare('SELECT id, audio_path FROM calls WHERE start_time_ms < ?').all(cutoff);
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const qs  = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM call_units WHERE call_id IN (${qs})`).run(...ids);
    db.prepare(`DELETE FROM calls      WHERE id      IN (${qs})`).run(...ids);
    return rows.map(r => r.audio_path).filter(Boolean);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function rowToCall(row) {
    return {
        id:           row.id,
        // Timing
        startTime:    new Date(row.start_time_ms).toISOString(),
        stopTime:     row.stop_time_ms    ? new Date(row.stop_time_ms).toISOString()  : null,
        callLengthMs: row.call_length_ms,
        // System / talkgroup
        systemId:     row.system_id,
        systemLabel:  row.system_label || '',
        talkgroupId:  row.talkgroup_id,
        tgLabel:      row.tg_label    || '',
        tgName:       row.tg_name     || '',
        tgGroup:      row.group_name  || '',
        tgGroupTag:   row.group_tag   || '',
        // RF
        freq:         row.freq,
        freqError:    row.freq_error,
        signal:       row.signal,
        noise:        row.noise,
        // Recorder
        sourceNum:    row.source_num,
        recorderNum:  row.recorder_num,
        tdmaSlot:     row.tdma_slot,
        phase2Tdma:   row.phase2_tdma,
        colorCode:    row.color_code,
        // Call attributes
        audioType:    row.audio_type,
        audioPath:    row.audio_path,
        priority:     row.priority,
        mode:         row.mode,
        duplex:       row.duplex,
        emergency:    !!row.emergency,
        encrypted:    !!row.encrypted,
        // JSON arrays
        freqList:     row.freq_list   ? JSON.parse(row.freq_list)   : [],
        srcList:      row.src_list    ? JSON.parse(row.src_list)    : [],
        patchedTgs:   row.patched_tgs ? JSON.parse(row.patched_tgs) : [],
        // units populated by attachUnits()
        units:        [],
    };
}

function attachUnits(db, calls) {
    if (!calls.length) return;
    const ids    = calls.map(c => c.id);
    const units  = db.prepare(`
        SELECT call_id, unit_id, unit_tag, signal_system, tx_time_ms, pos, emergency
        FROM call_units
        WHERE call_id IN (${ids.map(() => '?').join(',')})
        ORDER BY tx_time_ms
    `).all(...ids);

    const map = {};
    for (const u of units) {
        (map[u.call_id] = map[u.call_id] || []).push({
            unitId:       u.unit_id,
            tag:          u.unit_tag      || null,
            signalSystem: u.signal_system || null,
            txTime:       u.tx_time_ms    ? new Date(u.tx_time_ms).toISOString() : null,
            pos:          u.pos,
            emergency:    !!u.emergency,
        });
    }
    for (const c of calls) c.units = map[c.id] || [];
}

module.exports = {
    openDb,
    upsertSystem, upsertTalkgroup, insertCall,
    queryCalls, getCall, getSystems, queryUnits,
    deleteOldCalls,
};
