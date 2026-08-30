"use strict";
/**
 * EU DUAL 404 — Local Game Server
 * Speaks the senpa plaintext protocol (no WASM encryption).
 * Compatible with ONYX engine via WebSocket interceptor (ws:// for localhost).
 * 
 * Protocol: senpa FFA/DUAL plaintext
 * Port: 4444 (configurable via PORT env)
 * 
 * Server lifecycle:
 *   1. Client connects → server sends opcode 8 (auth request)
 *   2. Client sends opcode 13 (auth with JWT/null)
 *   3. Server sends opcode 0 (handshake: border, clientId, nTabs, playerIds)
 *   4. Client sends opcode 0 (spawn request)
 *   5. Server sends opcode 14 (world update) at 20 FPS
 *   6. Server sends opcode 21 (leaderboard) every 2s
 *   7. Client sends opcode 20 (cursor position) continuously
 *   8. Client sends opcode 22 (split), 23 (eject), 30 (ping), 31 (spectate)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const WS = require(path.join(__dirname, "node_modules", "ws"));

const PORT = parseInt(process.env.PORT || "4444", 10);
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;
const LEADERBOARD_INTERVAL = 2000;
const FOOD_COUNT = 500;
const VIRUS_COUNT = 10;
const WORLD_SIZE = 7000;
const BORDER = { top: 0, left: 0, bottom: WORLD_SIZE, right: WORLD_SIZE };
const MAX_NAME_LEN = 15;

let nextClientId = 1;
let nextCellId = 1;
let nextFoodId = 100000;
let nextVirusId = 200000;

const players = new Map();
const cells = new Map();
const foods = new Map();
const viruses = new Map();
const removedCells = new Set();
const eats = [];

function log(tag, msg) {
    const ts = new Date().toISOString().substr(11, 12);
    console.log(`[${ts}] [${tag}] ${msg}`);
}

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max)); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dist(a, b) { const dx = a.x - b.x; const dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
function massToRadius(mass) { return Math.sqrt(mass) * 2.8; }
function radiusToMass(r) { return (r / 2.8) * (r / 2.8); }

function randomColor() {
    const colors = [
        [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
        [255, 0, 255], [0, 255, 255], [255, 128, 0], [128, 0, 255],
        [255, 64, 64], [64, 255, 64], [64, 64, 255], [255, 192, 128],
        [192, 128, 255], [128, 255, 192], [255, 128, 192], [128, 192, 255]
    ];
    return colors[randInt(0, colors.length)];
}

function spawnFood() {
    const id = nextFoodId++;
    const r = massToRadius(1);
    foods.set(id, {
        id, x: rand(r, WORLD_SIZE - r), y: rand(r, WORLD_SIZE - r),
        radius: r, color: randomColor(), mass: 1
    });
    return id;
}

function spawnVirus() {
    const id = nextVirusId++;
    const mass = 100;
    viruses.set(id, {
        id, x: rand(100, WORLD_SIZE - 100), y: rand(100, WORLD_SIZE - 100),
        radius: massToRadius(mass), mass
    });
    return id;
}

function spawnPlayerCell(player, x, y, mass) {
    const id = nextCellId++;
    const radius = massToRadius(mass);
    const cell = {
        id, ownerId: player.clientId, x, y, radius, mass,
        color: player.color || randomColor(),
        vx: 0, vy: 0, targetX: x, targetY: y
    };
    cells.set(id, cell);
    player.cellIds.push(id);
    return cell;
}

function spawnPlayer(player) {
    const x = rand(200, WORLD_SIZE - 200);
    const y = rand(200, WORLD_SIZE - 200);
    spawnPlayerCell(player, x, y, 30);
    player.alive = true;
    player.spawnTime = Date.now();
    log("SPAWN", `Player ${player.clientId} (${player.nick || "unnamed"}) at ${Math.round(x)},${Math.round(y)} mass=30`);
}

function removeCell(cellId) {
    const cell = cells.get(cellId);
    if (!cell) return;
    cells.delete(cellId);
    removedCells.add(cellId);
    const player = players.get(cell.ownerId);
    if (player) {
        player.cellIds = player.cellIds.filter(id => id !== cellId);
        if (player.cellIds.length === 0) {
            player.alive = false;
            log("DEATH", `Player ${player.clientId} (${player.nick || "unnamed"}) died`);
            setTimeout(() => {
                if (player.ws && player.ws.readyState === WS.OPEN) {
                    spawnPlayer(player);
                }
            }, 500);
        }
    }
}

class BinaryWriter {
    constructor(size = 4096) {
        this.buffer = Buffer.alloc(size);
        this.offset = 0;
    }
    writeUInt8(v) { this.buffer.writeUInt8(v, this.offset); this.offset += 1; }
    writeInt8(v) { this.buffer.writeInt8(v, this.offset); this.offset += 1; }
    writeUInt16(v) { this.buffer.writeUInt16LE(v, this.offset); this.offset += 2; }
    writeInt16(v) { this.buffer.writeInt16LE(v, this.offset); this.offset += 2; }
    writeUInt32(v) { this.buffer.writeUInt32LE(v, this.offset); this.offset += 4; }
    writeInt32(v) { this.buffer.writeInt32LE(v, this.offset); this.offset += 4; }
    writeFloat32(v) { this.buffer.writeFloatLE(v, this.offset); this.offset += 4; }
    writeFloat64(v) { this.buffer.writeDoubleLE(v, this.offset); this.offset += 8; }
    writeString16(str) {
        this.writeUInt16(str.length);
        for (let i = 0; i < str.length; i++) {
            this.writeUInt16(str.charCodeAt(i));
        }
    }
    writeString8(str) {
        this.writeUInt8(str.length);
        for (let i = 0; i < str.length; i++) {
            this.writeUInt8(str.charCodeAt(i) & 0xFF);
        }
    }
    writeColor(rgb) {
        this.writeUInt8(rgb[0]);
        this.writeUInt8(rgb[1]);
        this.writeUInt8(rgb[2]);
    }
    get bufferSlice() { return this.buffer.slice(0, this.offset); }
    reset() { this.offset = 0; }
}

function sendAuthRequest(ws) {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(0x08, 0);
    ws.send(buf);
    log("TX", "→ auth request (opcode 8)");
}

function sendHandshake(ws, clientId, nTabs, playerIds) {
    const w = new BinaryWriter(64);
    w.writeUInt8(0x00);
    w.writeInt32(BORDER.top);
    w.writeInt32(BORDER.left);
    w.writeInt32(BORDER.bottom);
    w.writeInt32(BORDER.right);
    w.writeUInt16(clientId);
    w.writeUInt8(nTabs);
    for (let i = 0; i < nTabs; i++) {
        w.writeUInt16(playerIds[i]);
    }
    ws.send(w.bufferSlice);
    log("TX", `→ handshake: border=${WORLD_SIZE}x${WORLD_SIZE} client=${clientId} tabs=${nTabs}`);
}

function sendInit(ws) {
    const w = new BinaryWriter(8);
    w.writeUInt8(0x01);
    w.writeInt32(100);
    ws.send(w.bufferSlice);
}

function sendClientsList(ws) {
    const w = new BinaryWriter(4096);
    w.writeUInt8(0x0A);
    const list = Array.from(players.values()).slice(0, 50);
    w.writeUInt16(list.length);
    for (const p of list) {
        w.writeUInt16(p.clientId);
        w.writeUInt8(0);
        w.writeString16(p.nick || "");
    }
    ws.send(w.bufferSlice);
}

function sendPlayersList(ws) {
    const w = new BinaryWriter(8192);
    w.writeUInt8(0x0B);
    const list = Array.from(players.values()).slice(0, 50);
    w.writeUInt16(list.length);
    for (const p of list) {
        w.writeUInt16(p.clientId);
        w.writeUInt16(p.clientId);
        w.writeColor(p.color || [255, 255, 255]);
    }
    ws.send(w.bufferSlice);
}

function sendWorldUpdate(ws, player) {
    const w = new BinaryWriter(65536);
    w.writeUInt8(0x14);

    // Eat pairs (eaten, eater)
    const currentEats = eats.splice(0, eats.length);
    w.writeUInt16(currentEats.length);
    for (const e of currentEats) {
        w.writeInt32(e.eatenId);
        w.writeInt32(e.eaterId);
    }

    // Combine ALL entities: player cells + food + viruses
    const playerCells = Array.from(cells.values());
    const foodList = Array.from(foods.values());
    const virusList = Array.from(viruses.values());
    const allEntities = [...playerCells, ...foodList, ...virusList];

    // New cells (all entities)
    w.writeUInt32(allEntities.length);
    for (const c of allEntities) {
        w.writeUInt32(c.id);
        w.writeInt32(Math.round(c.x));
        w.writeInt32(Math.round(c.y));
        w.writeUInt16(Math.round(c.radius));

        if (foods.has(c.id)) {
            w.writeUInt8(0x02);
            w.writeColor(c.color || [255, 0, 0]);
        } else if (viruses.has(c.id)) {
            w.writeUInt8(0x01);
        } else {
            w.writeUInt8(0x00);
            w.writeUInt32(c.ownerId);
            w.writeColor(c.color || [255, 255, 255]);
        }
    }

    // Position updates (all entities)
    w.writeUInt32(allEntities.length);
    for (const c of allEntities) {
        w.writeUInt32(c.id);
        w.writeInt32(Math.round(c.x));
        w.writeInt32(Math.round(c.y));
        w.writeUInt16(Math.round(c.radius));
    }

    // Removals
    const removals = Array.from(removedCells);
    removedCells.clear();
    w.writeUInt32(removals.length);
    for (const id of removals) {
        w.writeUInt32(id);
    }

    // Self tab + camera zoom
    w.writeUInt8(0);
    w.writeFloat32(1.0);

    ws.send(w.bufferSlice);
}

function sendLeaderboard(ws) {
    const w = new BinaryWriter(4096);
    w.writeUInt8(0x15);

    const ranked = Array.from(cells.values())
        .filter(c => c.ownerId && players.has(c.ownerId) && !viruses.has(c.id) && !foods.has(c.id))
        .sort((a, b) => b.mass - a.mass);

    const uniqueByOwner = new Map();
    for (const c of ranked) {
        if (!uniqueByOwner.has(c.ownerId)) {
            uniqueByOwner.set(c.ownerId, c);
        }
    }

    const top = Array.from(uniqueByOwner.values()).slice(0, 10);

    w.writeUInt16(top.length);
    for (const c of top) {
        const p = players.get(c.ownerId);
        w.writeString16(p ? (p.nick || "") : "");
        w.writeUInt32(Math.round(c.mass));
    }

    ws.send(w.bufferSlice);
}

function sendSpectateData(ws, player) {
    const w = new BinaryWriter(128);
    w.writeUInt8(0x17);
    const target = Array.from(players.values()).find(p => p.alive && p.clientId !== player.clientId);
    if (target && target.cellIds.length > 0) {
        w.writeUInt8(target.cellIds.length);
        for (const cid of target.cellIds) {
            w.writeUInt32(cid);
        }
    } else {
        w.writeUInt8(0);
    }
    ws.send(w.bufferSlice);
}

function sendPingResponse(ws) {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(0x1E, 0);
    ws.send(buf);
}

function sendTimeUpdate(ws) {
    const w = new BinaryWriter(16);
    w.writeUInt8(0x05);
    const now = new Date();
    w.writeInt32(now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds());
    ws.send(w.bufferSlice);
}

function handleCursorPacket(player, data) {
    if (data.length < 2) return;
    const flags = data[1];
    let offset = 2;
    if (flags === 0x00 && data.length >= 3) {
        offset = 3; // tab_id byte
    }
    if (data.length >= offset + 8) {
        const x = data.readInt32LE(offset);
        const y = data.readInt32LE(offset + 4);
        for (const cid of player.cellIds) {
            const cell = cells.get(cid);
            if (cell) {
                cell.targetX = x;
                cell.targetY = y;
            }
        }
    }
}

function handleSpawnPacket(player, data) {
    if (data.length < 2) return;
    const tab = data[1];
    if (!player.alive) {
        spawnPlayer(player);
    }
}

function handleSplitPacket(player, data) {
    if (data.length < 3 || !player.alive) return;
    const count = data[2];
    const newCellIds = [];

    for (const cid of [...player.cellIds]) {
        const cell = cells.get(cid);
        if (!cell || cell.mass < 70) continue;

        const splitMass = cell.mass / 2;
        cell.mass = splitMass;
        cell.radius = massToRadius(splitMass);

        const angle = Math.atan2(cell.targetY - cell.y, cell.targetX - cell.x);
        const spawnDist = cell.radius * 1.5;
        const nx = cell.x + Math.cos(angle) * spawnDist;
        const ny = cell.y + Math.sin(angle) * spawnDist;

        const newCell = spawnPlayerCell(player, nx, ny, splitMass);
        newCell.vx = Math.cos(angle) * 30;
        newCell.vy = Math.sin(angle) * 30;
        newCellIds.push(newCell.id);
    }
}

function handleEjectPacket(player, data) {
    if (data.length < 3 || !player.alive) return;
    const dir = data[2];
    for (const cid of player.cellIds) {
        const cell = cells.get(cid);
        if (!cell || cell.mass < 40) continue;

        cell.mass -= 8;
        cell.radius = massToRadius(cell.mass);

        const angle = Math.atan2(cell.targetY - cell.y, cell.targetX - cell.x);
        const id = nextFoodId++;
        foods.set(id, {
            id,
            x: cell.x + Math.cos(angle) * (cell.radius + 20),
            y: cell.y + Math.sin(angle) * (cell.radius + 20),
            radius: massToRadius(8),
            color: cell.color,
            mass: 8,
            vx: Math.cos(angle) * 15,
            vy: Math.sin(angle) * 15
        });
    }
}

function physicsTick() {
    // Move cells towards targets
    for (const [, cell] of cells) {
        if (viruses.has(cell.id) || foods.has(cell.id)) continue;
        const dx = cell.targetX - cell.x;
        const dy = cell.targetY - cell.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) continue;

        const speed = Math.min(6.25 * Math.pow(cell.mass, -0.08) * 18, d);
        cell.x += (dx / d) * speed;
        cell.y += (dy / d) * speed;

        cell.x = clamp(cell.x, cell.radius, WORLD_SIZE - cell.radius);
        cell.y = clamp(cell.y, cell.radius, WORLD_SIZE - cell.radius);

        // Velocity decay (from split/eject)
        if (cell.vx || cell.vy) {
            cell.x += cell.vx;
            cell.y += cell.vy;
            cell.vx *= 0.85;
            cell.vy *= 0.85;
            if (Math.abs(cell.vx) < 0.1) cell.vx = 0;
            if (Math.abs(cell.vy) < 0.1) cell.vy = 0;
        }
    }

    // Cell merge (same owner, close enough)
    for (const [, cell] of cells) {
        if (viruses.has(cell.id) || foods.has(cell.id)) continue;
        const owner = players.get(cell.ownerId);
        if (!owner) continue;
        for (const otherId of owner.cellIds) {
            if (otherId === cell.id) continue;
            const other = cells.get(otherId);
            if (!other) continue;
            const d = dist(cell, other);
            const mergeThreshold = (cell.radius + other.radius) * 0.5;
            if (d < mergeThreshold && cell.mass > other.mass) {
                cell.mass += other.mass;
                cell.radius = massToRadius(cell.mass);
                removeCell(otherId);
            }
        }
    }

    // Food eating
    for (const [foodId, food] of foods) {
        for (const [, cell] of cells) {
            if (viruses.has(cell.id) || foods.has(cell.id)) continue;
            const d = dist(cell, food);
            if (d < cell.radius * 0.8) {
                cell.mass += food.mass;
                cell.radius = massToRadius(cell.mass);
                foods.delete(foodId);
                spawnFood();
                break;
            }
        }
    }

    // Player eating
    for (const [, cell] of cells) {
        if (viruses.has(cell.id) || foods.has(cell.id)) continue;
        for (const [otherId, other] of cells) {
            if (otherId === cell.id) continue;
            if (viruses.has(otherId) || foods.has(otherId)) continue;
            if (cell.mass < other.mass * 1.1) continue;
            const d = dist(cell, other);
            if (d < cell.radius - other.radius * 0.4) {
                eats.push({ eatenId: otherId, eaterId: cell.id });
                cell.mass += other.mass;
                cell.radius = massToRadius(cell.mass);
                removeCell(otherId);
            }
        }
    }

    // Virus collision
    for (const [virusId, virus] of viruses) {
        for (const [, cell] of cells) {
            if (viruses.has(cell.id) || foods.has(cell.id)) continue;
            if (cell.mass < virus.mass * 1.2) continue;
            const d = dist(cell, virus);
            if (d < cell.radius) {
                // Split the cell into pieces
                const pieces = Math.min(6, Math.floor(cell.mass / 26));
                const massEach = cell.mass / pieces;
                cell.mass = massEach;
                cell.radius = massToRadius(massEach);
                for (let i = 1; i < pieces; i++) {
                    const angle = (Math.PI * 2 * i) / pieces;
                    const nx = cell.x + Math.cos(angle) * (cell.radius + 10);
                    const ny = cell.y + Math.sin(angle) * (cell.radius + 10);
                    const newCell = spawnPlayerCell(cell.ownerId === virus.ownerId ? players.get(cell.ownerId) || { clientId: cell.ownerId, cellIds: [], nick: "", color: [255,255,255] } : players.get(cell.ownerId) || { clientId: cell.ownerId, cellIds: [], nick: "", color: [255,255,255] }, nx, ny, massEach);
                    newCell.vx = Math.cos(angle) * 20;
                    newCell.vy = Math.sin(angle) * 20;
                }
                // Respawn virus
                virus.x = rand(100, WORLD_SIZE - 100);
                virus.y = rand(100, WORLD_SIZE - 100);
                break;
            }
        }
    }

    // Cell decay (large cells shrink slowly)
    for (const [, cell] of cells) {
        if (viruses.has(cell.id) || foods.has(cell.id)) continue;
        if (cell.mass > 50) {
            cell.mass -= cell.mass * 0.0002;
            cell.radius = massToRadius(cell.mass);
        }
    }
}

// ─── SERVER SETUP ───

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("EU DUAL 404 — Local Game Server\nPort: " + PORT + "\nPlayers: " + players.size + "\nCells: " + cells.size + "\nFood: " + foods.size);
});

const wss = new WS.Server({ server, perMessageDeflate: false });

wss.on("connection", (ws, req) => {
    const clientId = nextClientId++;
    const address = req.socket.remoteAddress || "unknown";
    log("CONNECT", `Client ${clientId} from ${address}`);

    const player = {
        clientId,
        ws,
        nick: "",
        tag: "",
        color: randomColor(),
        cellIds: [],
        alive: false,
        spectating: false,
        alive1: false,
        alive2: false,
        alive3: false,
        joinTime: Date.now()
    };
    players.set(clientId, player);

    // Step 1: Send auth request
    sendAuthRequest(ws);

    // Step 2: Send handshake after a brief delay
    setTimeout(() => {
        if (ws.readyState === WS.OPEN) {
            sendHandshake(ws, clientId, 2, [clientId, clientId + 1000]);
            sendInit(ws);
            sendClientsList(ws);
            sendPlayersList(ws);
            sendTimeUpdate(ws);
        }
    }, 100);

    ws.on("message", (data) => {
        try {
            const buf = Buffer.from(data);
            if (buf.length === 0) return;
            const opcode = buf[0];

            switch (opcode) {
                case 0x00: // Spawn
                    handleSpawnPacket(player, buf);
                    break;

                case 0x0D: // Auth (JWT)
                    log("AUTH", `Client ${clientId} auth (len=${buf.length})`);
                    // Already handled in connection setup
                    break;

                case 0x0E: // Captcha
                    log("CAPTCHA", `Client ${clientId} captcha token`);
                    break;

                case 0x14: // Cursor position
                    handleCursorPacket(player, buf);
                    break;

                case 0x16: // Split
                    handleSplitPacket(player, buf);
                    break;

                case 0x17: // Eject
                    handleEjectPacket(player, buf);
                    break;

                case 0x1E: // Ping
                    sendPingResponse(ws);
                    break;

                case 0x1F: // Free spectate toggle
                    player.spectating = !player.spectating;
                    log("SPECTATE", `Client ${clientId} spectate=${player.spectating}`);
                    if (player.spectating) {
                        sendSpectateData(ws, player);
                    }
                    break;

                default:
                    log("UNK_OPCODE", `Client ${clientId} opcode=0x${opcode.toString(16)} len=${buf.length}`);
            }
        } catch (err) {
            log("ERROR", `Client ${clientId}: ${err.message}`);
        }
    });

    ws.on("close", (code, reason) => {
        log("DISCONNECT", `Client ${clientId} (${player.nick || "unnamed"}) code=${code}`);
        // Remove all cells
        for (const cid of player.cellIds) {
            cells.delete(cid);
            removedCells.add(cid);
        }
        players.delete(clientId);
    });

    ws.on("error", (err) => {
        log("WS_ERROR", `Client ${clientId}: ${err.message}`);
    });
});

// ─── INIT WORLD ───

for (let i = 0; i < FOOD_COUNT; i++) spawnFood();
for (let i = 0; i < VIRUS_COUNT; i++) spawnVirus();
log("INIT", `Food: ${foods.size}, Viruses: ${viruses.size}, World: ${WORLD_SIZE}x${WORLD_SIZE}`);

// ─── GAME LOOP ───

setInterval(() => {
    try {
        physicsTick();

        // Send world updates to all alive players
        for (const [, player] of players) {
            if (player.alive && player.ws && player.ws.readyState === WS.OPEN) {
                sendWorldUpdate(player.ws, player);
            }
        }
    } catch (err) {
        log("LOOP_ERR", err.message);
    }
}, TICK_MS);

// ─── LEADERBOARD LOOP ───

setInterval(() => {
    for (const [, player] of players) {
        if (player.ws && player.ws.readyState === WS.OPEN) {
            sendLeaderboard(player.ws);
            sendClientsList(player.ws);
            sendPlayersList(player.ws);
        }
    }
}, LEADERBOARD_INTERVAL);

// ─── START ───

server.listen(PORT, "0.0.0.0", () => {
    log("SERVER", "═══════════════════════════════════════════════════");
    log("SERVER", "  EU DUAL 404 — Local Game Server v1.0");
    log("SERVER", `  Port: ${PORT}`);
    log("SERVER", `  Protocol: senpa plaintext (no WASM encryption)`);
    log("SERVER", `  World: ${WORLD_SIZE}x${WORLD_SIZE}`);
    log("SERVER", `  Food: ${FOOD_COUNT}, Viruses: ${VIRUS_COUNT}`);
    log("SERVER", `  Tick rate: ${TICK_RATE} FPS`);
    log("SERVER", "═══════════════════════════════════════════════════");
    log("SERVER", "  Client URL: http://localhost:8888");
    log("SERVER", "  Server Info: http://localhost:" + PORT);
    log("SERVER", "═══════════════════════════════════════════════════");
});

// ─── GRACEFUL SHUTDOWN ───

process.on("SIGINT", () => {
    log("SHUTDOWN", "Closing all connections...");
    for (const [, player] of players) {
        if (player.ws) player.ws.close(1000, "Server shutting down");
    }
    wss.close(() => {
        server.close(() => {
            log("SHUTDOWN", "Server stopped.");
            process.exit(0);
        });
    });
    setTimeout(() => process.exit(0), 2000);
});

process.on("uncaughtException", (err) => {
    log("UNCAUGHT", err.message);
});
