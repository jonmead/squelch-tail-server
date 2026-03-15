'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Persist an audio buffer to disk under storageDir/YYYY/MM/DD/<name>
 * and return the relative path.
 *
 * The filename is supplied by the caller (typically the original audioName
 * from the trunk-recorder upload, e.g. "20240115_123456_460000000.m4a").
 *
 * @param {string} storageDir
 * @param {Buffer} buf
 * @param {string} filename    e.g. "20240115_123456_460000000.m4a"
 * @param {Date}   [date]      Defaults to now (used for YYYY/MM/DD bucketing)
 * @returns {string}           Relative path stored in DB, e.g. "2024/01/15/20240115_...m4a"
 */
function saveAudio(storageDir, buf, filename, date = new Date()) {
    const dir = dateDir(storageDir, date);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buf);
    return path.posix.join(
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
        filename,
    );
}

function deleteAudio(storageDir, relativePath) {
    if (!relativePath) return;
    try { fs.unlinkSync(path.join(storageDir, relativePath)); } catch (_) {}
}

/** Delete all audio files in YYYY/MM/DD dirs older than cutoffDate. */
function pruneAudioFiles(storageDir, paths) {
    for (const p of paths) deleteAudio(storageDir, p);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function dateDir(storageDir, date) {
    return path.join(
        storageDir,
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    );
}

module.exports = { saveAudio, deleteAudio, pruneAudioFiles };
