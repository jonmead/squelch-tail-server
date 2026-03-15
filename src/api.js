'use strict';

const fs   = require('fs');
const path = require('path');
const { queryCalls, getCall, getSystems, queryUnits } = require('./db');

/**
 * REST API handler — call this from the HTTP server's request handler.
 *
 * Routes:
 *   GET /api/systems              → [{id, label, talkgroups:[...]}]
 *   GET /api/calls                → {total, calls:[...]}
 *     ?systemId=1
 *     &talkgroupId=100
 *     &before=<ISO or ms>
 *     &after=<ISO or ms>
 *     &limit=50
 *     &offset=0
 *   GET /api/calls/:id            → single call object (with sources/freqs/patches)
 *   GET /audio/<relative-path>    → serve audio file
 *
 * Returns false if route not handled (so the caller can 404).
 */
function handleApi(req, res, db, config) {
    const url = new URL(req.url, 'http://localhost');

    // ── GET /api/systems ────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/systems') {
        return json(res, getSystems(db));
    }

    // ── GET /api/calls ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/calls') {
        const filters = {};
        const p = url.searchParams;
        if (p.has('systemId'))    filters.systemId    = parseInt(p.get('systemId'),    10);
        if (p.has('talkgroupId')) filters.talkgroupId = parseInt(p.get('talkgroupId'), 10);
        if (p.has('unitId'))      filters.unitId      = parseInt(p.get('unitId'),      10);
        if (p.has('before'))      filters.before      = toMs(p.get('before'));
        if (p.has('after'))       filters.after       = toMs(p.get('after'));
        if (p.has('limit'))       filters.limit       = Math.min(parseInt(p.get('limit'),  10) || 50, 200);
        if (p.has('offset'))      filters.offset      = parseInt(p.get('offset'), 10) || 0;
        return json(res, queryCalls(db, filters));
    }

    // ── GET /api/units ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/units') {
        const p = url.searchParams;
        const filters = {};
        if (p.has('systemId')) filters.systemId = parseInt(p.get('systemId'), 10);
        if (p.has('limit'))    filters.limit    = Math.min(parseInt(p.get('limit'),  10) || 100, 500);
        if (p.has('offset'))   filters.offset   = parseInt(p.get('offset'), 10) || 0;
        return json(res, queryUnits(db, filters));
    }

    // ── GET /api/calls/:id ──────────────────────────────────────────────────
    const callMatch = url.pathname.match(/^\/api\/calls\/(\d+)$/);
    if (req.method === 'GET' && callMatch) {
        const call = getCall(db, parseInt(callMatch[1], 10));
        if (!call) { res.writeHead(404); res.end('Not found\n'); return true; }
        return json(res, call);
    }

    // ── GET /audio/<path> ───────────────────────────────────────────────────
    // Supports HTTP Range requests so browser <audio> elements and players
    // can seek, and so only the requested bytes are transferred.
    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
        const rel  = url.pathname.slice('/audio/'.length);
        const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
        const full = path.join(config.storageDir, safe);

        let stat;
        try { stat = fs.statSync(full); } catch (_) {
            res.writeHead(404); res.end('Not found\n'); return true;
        }

        const ext  = path.extname(full).toLowerCase();
        const mime = { '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }[ext]
                     || 'application/octet-stream';
        const size = stat.size;

        const rangeHeader = req.headers['range'];
        if (rangeHeader) {
            // Parse "bytes=<start>-<end>" — only single-range supported
            const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
            if (!match) {
                res.writeHead(416, { 'Content-Range': `bytes */${size}` });
                res.end();
                return true;
            }
            // Suffix range "bytes=-N" → last N bytes
            const isSuffix = match[1] === '';
            const start = isSuffix ? size - parseInt(match[2], 10) : parseInt(match[1], 10);
            const end   = isSuffix || match[2] === '' ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);

            if (start > end || start < 0 || end >= size) {
                res.writeHead(416, { 'Content-Range': `bytes */${size}` });
                res.end();
                return true;
            }

            res.writeHead(206, {
                'Content-Type':   mime,
                'Content-Range':  `bytes ${start}-${end}/${size}`,
                'Content-Length': end - start + 1,
                'Accept-Ranges':  'bytes',
            });
            fs.createReadStream(full, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Type':   mime,
                'Content-Length': size,
                'Accept-Ranges':  'bytes',
            });
            fs.createReadStream(full).pipe(res);
        }
        return true;
    }

    return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res, data) {
    const body = JSON.stringify(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return true;
}

/** Accept ISO string or millisecond integer as a query-param timestamp. */
function toMs(str) {
    if (!str) return undefined;
    const n = Number(str);
    if (!isNaN(n)) return n;
    const d = new Date(str);
    return isNaN(d.getTime()) ? undefined : d.getTime();
}

module.exports = { handleApi };
