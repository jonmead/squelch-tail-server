#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const { openDb }            = require('./src/db');
const { makeUploadHandler } = require('./src/upload');
const { handleApi }         = require('./src/api');
const { WsServer }          = require('./src/ws-server');
const { startRetention }    = require('./src/retention');
const { printBanner }       = require('./src/banner');

// ── Config ────────────────────────────────────────────────────────────────────

const configPath = process.env.CONFIG || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.storageDir = path.resolve(__dirname, config.storageDir);
config.dbPath     = path.resolve(__dirname, config.dbPath);

fs.mkdirSync(config.storageDir, { recursive: true });

// ── Logger (minimal; swap for winston/pino if desired) ────────────────────────

const log = {
    info:  (...a) => console.log('[INFO] ', ...a),
    warn:  (...a) => console.warn('[WARN] ', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
};

// ── Database ──────────────────────────────────────────────────────────────────

const db = openDb(config.dbPath);

// ── HTTP server ───────────────────────────────────────────────────────────────

const uploadHandler = makeUploadHandler(db, config, (call) => {
    log.info(`Call  sys=${call.systemId} tg=${call.talkgroupId} freq=${call.frequency} id=${call.id}`);
    wsServer.pushCall(call);
});

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Trunk-recorder upload endpoint
    if (req.method === 'POST' && req.url === '/api/call-upload') {
        return uploadHandler(req, res);
    }

    // REST API + audio serving
    if (handleApi(req, res, db, config)) return;

    res.writeHead(404);
    res.end('Not found\n');
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const wsServer = new WsServer({ server, db, config });

// ── Retention ─────────────────────────────────────────────────────────────────

startRetention(db, config, log);

// ── Start ─────────────────────────────────────────────────────────────────────

const port = config.port || 51515;
server.listen(port, () => {
    printBanner(port);
    log.info(`Audio files  : ${config.storageDir}`);
    log.info(`Database     : ${config.dbPath}`);
    log.info(`Retention    : ${config.retentionDays} day(s)`);
});
