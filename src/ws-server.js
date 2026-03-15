'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { getSystems, queryCalls, queryUnits } = require('./db');

/**
 * WebSocket server — streams live calls to connected clients and handles
 * client-initiated search/filter requests.
 *
 * ── Protocol ─────────────────────────────────────────────────────────────────
 *
 * Server → Client (JSON objects):
 *   { type: "hello",  version: "1.0.0" }
 *   { type: "config", systems: [{id, label, talkgroups:[{id,label,name,group,tag}]}] }
 *   { type: "call",   call: { id, datetime, systemId, systemLabel, talkgroupId,
 *                             tgLabel, tgName, tgGroup, tgTag,
 *                             frequency, audioType, audioUrl } }
 *   { type: "calls",  calls: [...], total: N }
 *   { type: "error",  message: "..." }
 *
 * Client → Server (JSON objects):
 *   { type: "subscribe",   filter: { systems: { "1": { "100": true } } } }
 *   { type: "unsubscribe" }
 *   { type: "search",  systemId?, talkgroupId?, unitId?, before?, after?, limit?, offset? }
 *   { type: "fetch",     id: N }       — fetch a single call by id
 *   { type: "units",     systemId? }   — list known units
 *   { type: "getConfig" }             — re-send current systems/talkgroups config
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
class WsServer {
    /**
     * @param {object} opts
     * @param {object} opts.server  Node.js http.Server
     * @param {object} opts.db      better-sqlite3 database
     * @param {object} opts.config  { storageDir }
     */
    constructor({ server, db, config }) {
        this._db     = db;
        this._config = config;
        this._wss    = new WebSocketServer({ server, path: '/ws' });

        this._wss.on('connection', (ws) => this._onConnect(ws));
    }

    /**
     * Push a newly-received call to all subscribed clients.
     * @param {object} call  — enriched call object from upload handler
     */
    pushCall(call) {
        const msg = JSON.stringify({ type: 'call', call: this._toWire(call) });
        for (const ws of this._wss.clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (!this._matchesFilter(ws._filter, call)) continue;
            ws.send(msg);
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _onConnect(ws) {
        ws._filter = null; // no subscription until client sends one

        // Send greeting + current system/talkgroup config
        this._send(ws, { type: 'hello', version: '1.0.0' });
        this._send(ws, { type: 'config', systems: getSystems(this._db) });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch (_) {
                this._send(ws, { type: 'error', message: 'Invalid JSON' });
                return;
            }
            this._onMessage(ws, msg);
        });

        ws.on('error', () => {});
    }

    _onMessage(ws, msg) {
        switch (msg.type) {
            case 'subscribe':
                ws._filter = msg.filter || null;
                break;

            case 'unsubscribe':
                ws._filter = null;
                break;

            case 'search': {
                const filters = {};
                if (msg.systemId    != null) filters.systemId    = parseInt(msg.systemId,    10);
                if (msg.talkgroupId != null) filters.talkgroupId = parseInt(msg.talkgroupId, 10);
                if (msg.unitId      != null) filters.unitId      = parseInt(msg.unitId,      10);
                if (msg.before      != null) filters.before      = Number(msg.before);
                if (msg.after       != null) filters.after       = Number(msg.after);
                filters.limit  = Math.min(parseInt(msg.limit,  10) || 50, 200);
                filters.offset = parseInt(msg.offset, 10) || 0;
                const result = queryCalls(this._db, filters);
                this._send(ws, {
                    type:  'calls',
                    total: result.total,
                    calls: result.calls.map(c => this._toWire(c)),
                });
                break;
            }

            case 'units': {
                const uFilters = {};
                if (msg.systemId != null) uFilters.systemId = parseInt(msg.systemId, 10);
                uFilters.limit  = Math.min(parseInt(msg.limit,  10) || 100, 500);
                uFilters.offset = parseInt(msg.offset, 10) || 0;
                this._send(ws, { type: 'units', units: queryUnits(this._db, uFilters) });
                break;
            }

            case 'fetch': {
                const { getCall } = require('./db');
                const call = getCall(this._db, parseInt(msg.id, 10));
                if (!call) {
                    this._send(ws, { type: 'error', message: `Call ${msg.id} not found` });
                } else {
                    this._send(ws, { type: 'call', call: this._toWire(call) });
                }
                break;
            }

            case 'getConfig':
                this._send(ws, { type: 'config', systems: getSystems(this._db) });
                break;

            default:
                this._send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
        }
    }

    /** Add audioUrl to a call before sending over the wire. */
    _toWire(call) {
        return Object.assign({}, call, {
            audioUrl: call.audioPath ? `/audio/${call.audioPath}` : null,
        });
    }

    /**
     * Return true if the call should be delivered to a client with the given filter.
     * A null filter means the client receives all calls.
     *
     * Filter shape: { systems: { "<systemId>": { "<tgId>": true|false, ... } } }
     *   true  → subscribed to that talkgroup
     *   false → avoided (skip)
     *   omitting a tg → included by default
     */
    _matchesFilter(filter, call) {
        if (!filter) return true;
        const { systems } = filter;
        if (!systems) return true;

        const sysFilter = systems[String(call.systemId)];
        if (sysFilter === undefined) return true; // system not mentioned → include

        // If system key exists, check talkgroup
        const tgVal = sysFilter[String(call.talkgroupId)];
        if (tgVal === undefined) return true;
        return tgVal !== false;
    }

    _send(ws, obj) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }
}

module.exports = { WsServer };
