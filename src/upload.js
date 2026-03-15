'use strict';

const Busboy = require('busboy');
const { upsertSystem, upsertTalkgroup, insertCall } = require('./db');
const { saveAudio } = require('./storage');

/**
 * Build an HTTP request handler for trunk-recorder call uploads.
 *
 * trunk-recorder writes two files per call:
 *   <timestamp>-<tg>_<freq>-call_<n>.m4a   — audio
 *   <timestamp>-<tg>_<freq>-call_<n>.json  — metadata
 *
 * POST multipart/form-data to /api/call-upload:
 *   Field  key     (required) — API key
 *   Field  system  (required) — numeric system ID (not present in TR's JSON)
 *   File   audio   (required) — the audio file
 *   File   meta    (required) — the JSON metadata file
 *
 * All fields in the TR JSON are ingested and stored.
 * See trunk-recorder/call_concluder/call_concluder.cc: create_call_json()
 * for the authoritative list of fields.
 */
function makeUploadHandler(db, config, onCall) {
    return function handleUpload(req, res) {
        let apiKey    = null;
        let systemId  = null;
        let audioBuf  = null;
        let audioName = null;
        let metaBuf   = null;

        let bb;
        try {
            bb = Busboy({ headers: req.headers });
        } catch (_) {
            res.writeHead(400); res.end('Bad request\n'); return;
        }

        bb.on('field', (name, value) => {
            if (name === 'key')    apiKey   = value;
            if (name === 'system') systemId = parseInt(value, 10);
        });

        bb.on('file', (name, stream, info) => {
            if (name === 'audio') {
                audioName = info.filename || 'audio.m4a';
                const chunks = [];
                stream.on('data', c => chunks.push(c));
                stream.on('end',  () => { audioBuf = Buffer.concat(chunks); });
            } else if (name === 'meta') {
                const chunks = [];
                stream.on('data', c => chunks.push(c));
                stream.on('end',  () => { metaBuf = Buffer.concat(chunks); });
            } else {
                stream.resume();
            }
        });

        bb.on('finish', () => {
            // ── Auth ─────────────────────────────────────────────────────────
            if (apiKey !== config.apiKey) {
                res.writeHead(401); res.end('Unauthorized\n'); return;
            }

            if (!audioBuf || !metaBuf || !systemId) {
                res.writeHead(417); res.end('Missing required fields (system, audio, meta)\n'); return;
            }

            // ── Parse TR metadata JSON ────────────────────────────────────────
            let meta;
            try {
                meta = JSON.parse(metaBuf.toString('utf8'));
            } catch (_) {
                res.writeHead(417); res.end('Invalid meta JSON\n'); return;
            }

            // start_time_ms is preferred; fall back to start_time (seconds) * 1000
            const startTimeMs = meta.start_time_ms != null
                ? meta.start_time_ms
                : (meta.start_time != null ? meta.start_time * 1000 : null);

            if (startTimeMs == null) {
                res.writeHead(417); res.end('meta missing start_time / start_time_ms\n'); return;
            }

            const date        = new Date(startTimeMs);
            const talkgroupId = parseInt(meta.talkgroup, 10);

            // ── Upsert system + talkgroup ─────────────────────────────────────
            upsertSystem(db, systemId, meta.short_name || '');

            if (!isNaN(talkgroupId)) {
                upsertTalkgroup(db, systemId, {
                    id:        talkgroupId,
                    label:     meta.talkgroup_tag         || '',
                    name:      meta.talkgroup_description || '',
                    groupName: meta.talkgroup_group       || '',
                    groupTag:  meta.talkgroup_group_tag   || '',
                });
            }

            // ── Save audio file ───────────────────────────────────────────────
            const safeName  = (audioName || 'audio.m4a').replace(/[^a-zA-Z0-9._\-]/g, '_');
            const audioPath = saveAudio(config.storageDir, audioBuf, safeName, date);

            // ── Build call record — every TR field captured ───────────────────
            const callRecord = {
                startTimeMs,
                stopTimeMs:   meta.stop_time_ms  ?? (meta.stop_time  != null ? meta.stop_time  * 1000 : null),
                callLengthMs: meta.call_length_ms ?? (meta.call_length != null ? meta.call_length * 1000 : null),
                systemId,
                talkgroupId:  isNaN(talkgroupId) ? null : talkgroupId,
                freq:         meta.freq        ?? null,
                freqError:    meta.freq_error  ?? null,
                signal:       meta.signal      ?? null,
                noise:        meta.noise       ?? null,
                sourceNum:    meta.source_num  ?? null,
                recorderNum:  meta.recorder_num ?? null,
                tdmaSlot:     meta.tdma_slot   ?? null,
                phase2Tdma:   meta.phase2_tdma ?? null,
                colorCode:    meta.color_code  ?? null,
                audioType:    meta.audio_type  || null,
                audioPath,
                priority:     meta.priority    ?? null,
                mode:         meta.mode        ?? null,
                duplex:       meta.duplex      ?? null,
                emergency:    meta.emergency   || 0,
                encrypted:    meta.encrypted   || 0,
                freqList:     Array.isArray(meta.freqList)          ? meta.freqList          : null,
                srcList:      Array.isArray(meta.srcList)           ? meta.srcList           : null,
                patchedTgs:   Array.isArray(meta.patched_talkgroups)? meta.patched_talkgroups: null,
            };

            const callId = insertCall(db, callRecord);

            // ── Assemble the call object pushed to live clients ───────────────
            const call = {
                id:          callId,
                startTime:   date.toISOString(),
                stopTime:    callRecord.stopTimeMs   ? new Date(callRecord.stopTimeMs).toISOString() : null,
                callLengthMs: callRecord.callLengthMs,
                systemId,
                systemLabel: meta.short_name          || '',
                talkgroupId: callRecord.talkgroupId,
                tgLabel:     meta.talkgroup_tag         || '',
                tgName:      meta.talkgroup_description || '',
                tgGroup:     meta.talkgroup_group       || '',
                tgGroupTag:  meta.talkgroup_group_tag   || '',
                freq:        callRecord.freq,
                freqError:   callRecord.freqError,
                signal:      callRecord.signal,
                noise:       callRecord.noise,
                sourceNum:   callRecord.sourceNum,
                recorderNum: callRecord.recorderNum,
                tdmaSlot:    callRecord.tdmaSlot,
                phase2Tdma:  callRecord.phase2Tdma,
                colorCode:   callRecord.colorCode,
                audioType:   callRecord.audioType,
                audioPath,
                priority:    callRecord.priority,
                mode:        callRecord.mode,
                duplex:      callRecord.duplex,
                emergency:   !!callRecord.emergency,
                encrypted:   !!callRecord.encrypted,
                freqList:    callRecord.freqList   || [],
                srcList:     callRecord.srcList    || [],
                patchedTgs:  callRecord.patchedTgs || [],
                units: (callRecord.srcList || [])
                    .map(s => ({
                        unitId:       parseInt(s.src, 10),
                        tag:          s.tag           || null,
                        signalSystem: s.signal_system || null,
                        txTime:       s.time != null  ? new Date(Math.round(s.time * 1000)).toISOString() : null,
                        pos:          s.pos  ?? null,
                        emergency:    !!s.emergency,
                    }))
                    .filter(u => !isNaN(u.unitId)),
            };

            onCall(call);

            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Call imported successfully.\n');
        });

        bb.on('error', () => { res.writeHead(500); res.end('Upload error\n'); });
        req.pipe(bb);
    };
}

module.exports = { makeUploadHandler };
