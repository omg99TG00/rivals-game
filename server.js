const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Constants ──────────────────────────────────────────────
const REGIONS = ['AS', 'EU', 'NA', 'SA'];
const SERVERS_PER_REGION = 10;
const MAX_PLAYERS = 25;
const MAP_SIZE = 900;
const WALL_THICKNESS = 20;
const BULLET_SPEED = 20;
const BULLET_DAMAGE = 30;
const BULLET_MAX_DIST = 700;
const TICK_RATE = 60;
const PLAYER_RADIUS = 18;

// ── Build 40 rooms ─────────────────────────────────────────
const gameRooms = {};
REGIONS.forEach(region => {
  for (let i = 1; i <= SERVERS_PER_REGION; i++) {
    const roomId = `${region}-${i}`;
    gameRooms[roomId] = {
      id: roomId, region, number: i,
      players: {}, bullets: {}, bulletIdCounter: 0
    };
  }
});

function getRoomList() {
  return Object.values(gameRooms).map(r => ({
    id: r.id, region: r.region, number: r.number,
    playerCount: Object.keys(r.players).length,
    maxPlayers: MAX_PLAYERS,
    full: Object.keys(r.players).length >= MAX_PLAYERS
  }));
}

function getRandomSpawn() {
  const margin = 100;
  return {
    x: margin + Math.random() * (MAP_SIZE - margin * 2),
    z: margin + Math.random() * (MAP_SIZE - margin * 2)
  };
}

function makeInventory() {
  return [
    { id: 'musket', name: 'Musket', type: 'weapon', icon: '🔫', ammoType: 'musketammo', damage: 30, slot: 0 },
    { id: 'musketammo', name: 'Musket Ammo', type: 'ammo', icon: '🔮', quantity: 30, slot: 1 },
    { id: 'cookedmeat', name: 'Cooked Meat', type: 'food', icon: '🍖', quantity: 5, healAmount: 20, hungerAmount: 20, slot: 2 },
    null, null
  ];
}

function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

// ── Connections ────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('roomList', getRoomList());

  function broadcastRooms() { io.emit('roomList', getRoomList()); }

  // ── Join ─────────────────────────────────────────────────
  socket.on('joinRoom', ({ roomId, username }) => {
    const room = gameRooms[roomId];
    if (!room) return socket.emit('gameError', 'Room not found');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('gameError', 'Server is full!');
    if (socket.currentRoom) leaveRoom(socket);

    const guestNum = Object.keys(room.players).length + 1;
    const name = (username && username.trim()) ? username.trim() : `Guest ${guestNum}`;
    const spawn = getRandomSpawn();

    const player = {
      id: socket.id, name,
      x: spawn.x, z: spawn.z,
      rotY: 0,
      health: 100, maxHealth: 100,
      hunger: 100, maxHunger: 100,
      inventory: makeInventory(),
      activeSlot: 0,
      isMoving: false, isSprinting: false,
      isDead: false,
      kills: 0, deaths: 0,
      joinTime: Date.now()
    };

    room.players[socket.id] = player;
    socket.currentRoom = roomId;
    socket.join(roomId);

    socket.emit('joinedRoom', {
      roomId, playerId: socket.id, player,
      players: room.players, mapSize: MAP_SIZE
    });
    socket.to(roomId).emit('playerJoined', {
      id: player.id, name: player.name,
      x: player.x, z: player.z,
      health: player.health, rotY: 0,
      isMoving: false, isSprinting: false
    });
    broadcastRooms();
  });

  // ── Move ─────────────────────────────────────────────────
  socket.on('playerMove', (data) => {
    const room = gameRooms[socket.currentRoom];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || p.isDead) return;
    p.x = clamp(data.x, WALL_THICKNESS + 5, MAP_SIZE - WALL_THICKNESS - 5);
    p.z = clamp(data.z, WALL_THICKNESS + 5, MAP_SIZE - WALL_THICKNESS - 5);
    p.rotY = data.rotY;
    p.isMoving = data.isMoving;
    p.isSprinting = data.isSprinting;
    socket.to(socket.currentRoom).emit('playerMoved', {
      id: socket.id, x: p.x, z: p.z,
      rotY: p.rotY, isMoving: p.isMoving, isSprinting: p.isSprinting
    });
  });

  // ── Shoot ────────────────────────────────────────────────
  socket.on('shoot', (data) => {
    const room = gameRooms[socket.currentRoom];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || p.isDead) return;

    const ammoSlot = p.inventory.find(s => s && s.id === 'musketammo');
    if (!ammoSlot || ammoSlot.quantity <= 0) {
      socket.emit('noAmmo', "You don't have enough ammo to shoot!");
      return;
    }
    ammoSlot.quantity--;
    socket.emit('inventoryUpdate', p.inventory);

    const bulletId = `${socket.id}_${++room.bulletIdCounter}`;
    room.bullets[bulletId] = {
      id: bulletId, ownerId: socket.id, ownerName: p.name,
      x: data.x, z: data.z,
      dirX: data.dirX, dirZ: data.dirZ,
      distTravelled: 0, damage: BULLET_DAMAGE
    };
    io.to(socket.currentRoom).emit('bulletFired', room.bullets[bulletId]);
  });

  // ── Eat ──────────────────────────────────────────────────
  socket.on('eatFood', (slotIndex) => {
    const room = gameRooms[socket.currentRoom];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || p.isDead) return;
    const slot = p.inventory[slotIndex];
    if (!slot || slot.type !== 'food' || slot.quantity <= 0) return;

    slot.quantity--;
    p.health = clamp(p.health + slot.healAmount, 0, p.maxHealth);
    p.hunger = clamp(p.hunger + slot.hungerAmount, 0, p.maxHunger);
    if (slot.quantity <= 0) p.inventory[slotIndex] = null;

    socket.emit('statsUpdate', { health: p.health, hunger: p.hunger });
    socket.emit('inventoryUpdate', p.inventory);
    socket.to(socket.currentRoom).emit('playerStatsChanged', { id: socket.id, health: p.health });
  });

  // ── Switch slot ──────────────────────────────────────────
  socket.on('switchSlot', (i) => {
    const room = gameRooms[socket.currentRoom];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    p.activeSlot = i;
    socket.emit('slotSwitched', i);
  });

  // ── Chat ─────────────────────────────────────────────────
  socket.on('chatMsg', (data) => {
    const room = gameRooms[socket.currentRoom];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    const msg = String(data.msg||'').trim().slice(0, 80);
    if (!msg) return;
    const isGuest = p.name.startsWith('Guest ');
    io.to(socket.currentRoom).emit('chatMsg', {
      name: p.name,
      msg,
      isGuest
    });
  });

  // ── Leave ────────────────────────────────────────────────
  socket.on('leaveRoom', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));

  function leaveRoom(sock) {
    if (!sock.currentRoom) return;
    const room = gameRooms[sock.currentRoom];
    if (room) {
      delete room.players[sock.id];
      sock.to(sock.currentRoom).emit('playerLeft', sock.id);
    }
    sock.leave(sock.currentRoom);
    sock.currentRoom = null;
    broadcastRooms();
  }
});

// ── Bullet physics tick ────────────────────────────────────
setInterval(() => {
  Object.values(gameRooms).forEach(room => {
    const toRemove = [];
    Object.values(room.bullets).forEach(b => {
      b.x += b.dirX * BULLET_SPEED;
      b.z += b.dirZ * BULLET_SPEED;
      b.distTravelled += BULLET_SPEED;

      if (b.distTravelled >= BULLET_MAX_DIST ||
          b.x <= WALL_THICKNESS || b.x >= MAP_SIZE - WALL_THICKNESS ||
          b.z <= WALL_THICKNESS || b.z >= MAP_SIZE - WALL_THICKNESS) {
        toRemove.push(b.id);
        io.to(room.id).emit('bulletDestroyed', b.id);
        return;
      }

      Object.values(room.players).forEach(p => {
        if (p.id === b.ownerId || p.isDead) return;
        const dx = p.x - b.x, dz = p.z - b.z;
        if (Math.sqrt(dx*dx + dz*dz) < PLAYER_RADIUS) {
          p.health = Math.max(0, p.health - b.damage);
          toRemove.push(b.id);
          io.to(room.id).emit('bulletDestroyed', b.id);
          io.to(room.id).emit('playerHit', { id: p.id, health: p.health, hitByName: b.ownerName });

          if (p.health <= 0) {
            p.isDead = true;
            p.deaths++;
            const shooter = room.players[b.ownerId];
            if (shooter) {
              shooter.kills++;
              // Leaderboard broadcast
              io.to(room.id).emit('killFeed', { killer: b.ownerName, victim: p.name, weapon: 'Musket' });
            }
            io.to(p.id).emit('youDied', { killedBy: b.ownerName, weapon: 'Musket' });
            io.to(room.id).emit('playerDied', { id: p.id, killedBy: b.ownerName });
          }
        }
      });
    });
    toRemove.forEach(id => delete room.bullets[id]);
  });
}, 1000 / TICK_RATE);

// ── Hunger decay (every 6s) ────────────────────────────────
setInterval(() => {
  Object.values(gameRooms).forEach(room => {
    Object.values(room.players).forEach(p => {
      if (p.isDead) return;
      p.hunger = Math.max(0, p.hunger - 1);
      if (p.hunger === 0) p.health = Math.max(1, p.health - 2);
      io.to(p.id).emit('statsUpdate', { health: p.health, hunger: p.hunger });
    });
  });
}, 6000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Rivals server running on port ${PORT}`));
