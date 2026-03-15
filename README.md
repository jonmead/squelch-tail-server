<div align="center">
  <img src="logo.svg" alt="Squelch Tail" width="420"/>
  <p><em>Self-hosted radio call server for trunk-recorder</em></p>
</div>

---

Squelch Tail receives call recordings from [trunk-recorder](https://github.com/robotastic/trunk-recorder), stores them, and streams them to connected clients in real time. It is a complete, self-contained replacement for the recording and distribution layer — no third-party cloud services required.

```
trunk-recorder  ──►  Squelch Tail  ──►  browser / player / CLI
     (records)           (stores)            (streams)
```

---

## Features

- **trunk-recorder native integration** — C++ plugin uploads audio + metadata automatically on call end
- **Full metadata storage** — every field from trunk-recorder's JSON is captured (signal, noise, TDMA, frequency error, recorder info, unit transmissions, etc.)
- **Live call streaming** — WebSocket push to all connected clients the moment a call lands
- **Unit ID tracking** — per-transmission unit activity with timestamps, searchable by radio ID
- **HTTP audio serving** — full Range request support for seeking and browser `<audio>` compatibility
- **Configurable retention** — automatic cleanup of calls and audio files older than N days
- **Simple REST API** — query calls, systems, talkgroups, and units with filters
- **No external dependencies** — SQLite database, local audio file storage, Node.js

---

## Requirements

| Component | Version |
|---|---|
| Node.js | 18 or later |
| trunk-recorder | 4.x (for C++ plugin) |
| libcurl | any (for C++ plugin) |

---

## Quick Start

```bash
git clone <repo-url> squelch-tail
cd squelch-tail
npm install
cp config.json config.local.json   # edit as needed
node index.js
```

Server starts on port `5000` by default.

---

## Configuration

Edit `config.json` (or point `CONFIG=/path/to/file` env var at an alternative):

```json
{
  "port":          5000,
  "apiKey":        "changeme",
  "retentionDays": 14,
  "storageDir":    "./storage/audio",
  "dbPath":        "./storage/radio.db"
}
```

| Key | Description |
|---|---|
| `port` | HTTP / WebSocket listen port (default `5000`) |
| `apiKey` | Shared secret — trunk-recorder plugin must send this with every upload |
| `retentionDays` | Calls and audio files older than this are deleted automatically (0 = keep forever) |
| `storageDir` | Directory for audio files — bucketed by `YYYY/MM/DD/` |
| `dbPath` | SQLite database path |

---

## trunk-recorder Integration

Squelch Tail ships a C++ plugin that hooks into trunk-recorder's plugin API. It runs in-process and uploads each call automatically the moment recording ends — no scripts, no polling, no intermediate files.

**1. Build**

Copy `plugins/trunk-recorder/` into trunk-recorder's `plugins/` directory:

```bash
cp -r /path/to/squelch-tail/plugins/trunk-recorder \
       /path/to/trunk-recorder/plugins/squelch_tail_uploader
```

Add to trunk-recorder's root `CMakeLists.txt`:

```cmake
add_subdirectory(plugins/squelch_tail_uploader)
```

Rebuild trunk-recorder normally. The shared library is installed alongside the other plugins.

**2. Configure**

Add a `plugins` entry to trunk-recorder's `config.json`:

```json
{
  "plugins": [{
    "name":    "squelch_tail_uploader",
    "library": "libsquelch_tail_uploader",
    "server":  "http://192.168.1.10:5000",
    "systems": [{
      "shortName": "county",
      "apiKey":    "changeme",
      "systemId":  1
    }]
  }]
}
```

Add one entry to `systems` for each trunk-recorder system you want to ingest. The `shortName` must match the system's `shortName` in the rest of the trunk-recorder config.

**What the plugin sends**

On `call_end` the plugin POSTs two parts to `/api/call-upload`:

| Part | Content |
|---|---|
| `audio` | The call audio file (m4a or wav depending on trunk-recorder config) |
| `meta` | The complete trunk-recorder JSON metadata, serialised directly from `call_json` |

Encrypted calls are skipped automatically.

---

## Upload Endpoint

trunk-recorder plugins POST to:

```
POST /api/call-upload
Content-Type: multipart/form-data

  key     <string>   API key
  system  <integer>  Numeric system ID
  audio   <file>     Audio file (.m4a)
  meta    <file>     trunk-recorder JSON metadata file
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Call imported successfully |
| `401` | Invalid API key |
| `417` | Missing required fields or malformed metadata |

---

## REST API

All endpoints return JSON. No authentication required for reads.

### `GET /api/systems`

Returns all known systems and their talkgroups.

```json
[
  {
    "id": 1,
    "label": "county",
    "talkgroups": [
      { "id": 100, "label": "Fire 1", "name": "County Fire Dispatch",
        "groupName": "Fire", "groupTag": "Fire Dispatch" }
    ]
  }
]
```

---

### `GET /api/calls`

Returns a paginated list of calls, newest first. Each call includes unit transmissions.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `systemId` | integer | Filter by system |
| `talkgroupId` | integer | Filter by talkgroup |
| `unitId` | integer | Filter to calls where this radio unit transmitted |
| `before` | ms or ISO | Only calls before this timestamp |
| `after` | ms or ISO | Only calls at or after this timestamp |
| `limit` | integer | Max results (default 50, max 200) |
| `offset` | integer | Pagination offset |

**Response**

```json
{
  "total": 1842,
  "calls": [
    {
      "id": 1,
      "startTime":    "2024-01-15T14:23:45.089Z",
      "stopTime":     "2024-01-15T14:23:47.709Z",
      "callLengthMs": 1620,
      "systemId":     1,
      "systemLabel":  "county",
      "talkgroupId":  18,
      "tgLabel":      "Boxboro PD",
      "tgName":       "Boxboro Police Department",
      "tgGroup":      "",
      "tgGroupTag":   "police",
      "freq":         155647500,
      "freqError":    30,
      "signal":       -22,
      "noise":        -39,
      "sourceNum":    2,
      "recorderNum":  3,
      "tdmaSlot":     0,
      "phase2Tdma":   0,
      "colorCode":    0,
      "audioType":    "digital",
      "audioPath":    "2024/01/15/1234567890-18_155647500.m4a",
      "priority":     0,
      "mode":         0,
      "duplex":       0,
      "emergency":    false,
      "encrypted":    false,
      "freqList":     [ { "freq": 155647500, "time": 1705329825, "pos": 0, "len": 1.62, "error_count": 0, "spike_count": 0 } ],
      "srcList":      [ { "src": 47889, "time": 1705329825, "pos": 0, "emergency": 0, "signal_system": "", "tag": "" } ],
      "patchedTgs":   [],
      "units": [
        { "unitId": 47889, "tag": null, "signalSystem": null,
          "txTime": "2024-01-15T14:23:45.000Z", "pos": 0, "emergency": false }
      ]
    }
  ]
}
```

---

### `GET /api/calls/:id`

Returns a single call by ID (same shape as the entries in `/api/calls`).

---

### `GET /api/units`

Returns all radio units seen, ordered by most-recently-heard.

**Query parameters:** `systemId`, `limit` (max 500), `offset`

```json
[
  { "unitId": 47889, "tag": "CAR1", "callCount": 142, "lastSeen": "2024-01-15T14:23:45.000Z" }
]
```

---

### `GET /audio/<path>`

Serves an audio file. `<path>` is the `audioPath` value from a call object.

Supports HTTP `Range` requests — required for browser `<audio>` elements and seeking.

```
GET /audio/2024/01/15/1234567890-18_155647500.m4a
Range: bytes=0-65535
```

---

## WebSocket API

Connect to `ws://<host>:<port>/ws`.

On connect the server sends:

```json
{ "type": "hello",  "version": "1.0.0" }
{ "type": "config", "systems": [ ... ] }
```

---

### Client → Server messages

**Subscribe to live calls**

```json
{
  "type": "subscribe",
  "filter": {
    "systems": {
      "1": { "100": true, "200": false }
    }
  }
}
```

Omit `filter` or send `null` to receive all calls. Set a talkgroup to `false` to exclude it.

**Unsubscribe**

```json
{ "type": "unsubscribe" }
```

**Search**

```json
{
  "type":        "search",
  "systemId":    1,
  "talkgroupId": 100,
  "unitId":      47889,
  "before":      1705329825000,
  "after":       1705243425000,
  "limit":       50,
  "offset":      0
}
```

All fields optional. Returns a `calls` message.

**Fetch single call**

```json
{ "type": "fetch", "id": 42 }
```

**List units**

```json
{ "type": "units", "systemId": 1, "limit": 100 }
```

---

### Server → Client messages

| Type | Description |
|---|---|
| `hello` | Sent on connect — `{ version }` |
| `config` | System + talkgroup list — sent on connect and whenever systems change |
| `call` | A single call object (live push or fetch response) — includes `audioUrl` |
| `calls` | Search results — `{ total, calls[] }` |
| `units` | Unit list — `{ units[] }` |
| `error` | `{ message }` |

**Live call push**

```json
{
  "type": "call",
  "call": {
    "id":        1,
    "startTime": "2024-01-15T14:23:45.089Z",
    "systemId":  1,
    "tgLabel":   "Boxboro PD",
    "freq":      155647500,
    "audioUrl":  "/audio/2024/01/15/1234567890-18_155647500.m4a",
    "units":     [ { "unitId": 47889, "txTime": "2024-01-15T14:23:45.000Z" } ]
  }
}
```

---

## Data Model

### Call fields

| Field | Source | Description |
|---|---|---|
| `startTime` / `stopTime` | `start_time_ms` / `stop_time_ms` | ms-precision timestamps |
| `callLengthMs` | `call_length_ms` | Duration in milliseconds |
| `freq` | `freq` | Channel frequency (Hz) |
| `freqError` | `freq_error` | Frequency error (Hz) |
| `signal` | `signal` | Signal level (dBm) |
| `noise` | `noise` | Noise floor (dBm) |
| `sourceNum` | `source_num` | trunk-recorder source number |
| `recorderNum` | `recorder_num` | trunk-recorder recorder number |
| `tdmaSlot` | `tdma_slot` | TDMA slot (0 or 1) |
| `phase2Tdma` | `phase2_tdma` | Phase 2 TDMA flag |
| `colorCode` | `color_code` | P25/DMR color code |
| `audioType` | `audio_type` | `"digital"` or `"analog"` |
| `priority` | `priority` | Call priority |
| `mode` | `mode` | Conventional / trunked mode flag |
| `duplex` | `duplex` | Duplex flag |
| `freqList` | `freqList` | Per-transmission frequency + error data |
| `srcList` | `srcList` | Per-transmission unit source list |
| `patchedTgs` | `patched_talkgroups` | Patched talkgroup IDs |

### Unit fields (per transmission)

| Field | Description |
|---|---|
| `unitId` | Radio unit ID (`src`) |
| `tag` | Unit alias (if configured in trunk-recorder) |
| `signalSystem` | Cross-patch signal system name |
| `txTime` | ISO timestamp of transmission |
| `pos` | Position within recording (seconds) |
| `emergency` | Emergency flag |

---

## Storage Layout

```
storage/
  audio/
    2024/
      01/
        15/
          1234567890-18_155647500.m4a
          1234567891-100_460212500.m4a
  radio.db
```

Audio files are named by trunk-recorder and stored verbatim, bucketed by UTC date. The SQLite database holds all metadata; audio files hold only binary audio.

---

## Single-page application webclient included
Run with `npm run start-webclient` which just serves the webclient/index.html folder. 

## License

MIT
