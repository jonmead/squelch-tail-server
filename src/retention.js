'use strict';

const { deleteOldCalls } = require('./db');
const { pruneAudioFiles } = require('./storage');

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Delete calls and audio files older than retentionDays.
 * Runs immediately on startup, then every 6 hours.
 *
 * @param {object} db
 * @param {object} config  { storageDir, retentionDays }
 * @param {object} log     logger with .info() / .warn()
 */
function startRetention(db, config, log) {
    function run() {
        const days = config.retentionDays;
        if (!days || days <= 0) return;
        const cutoffMs = days * 24 * 60 * 60 * 1000;
        const paths    = deleteOldCalls(db, cutoffMs);
        if (paths.length > 0) {
            pruneAudioFiles(config.storageDir, paths);
            log.info(`Retention: removed ${paths.length} call(s) older than ${days} day(s)`);
        }
    }

    run();
    setInterval(run, SIX_HOURS).unref();
}

module.exports = { startRetention };
