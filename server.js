const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Permite conexão de qualquer IP/origem
});

app.use(express.static(path.join(__dirname, 'public')));

const MAP_SIZE = 2400;
const MAX_PLAYERS = 50;

// Descobre o IP local automaticamente para facilitar
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let name of Object.keys(interfaces)) {
        for (let iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Estrutura das Salas
const rooms = {};

function createRoom(id, name) {
    rooms[id] = {
        id,
        name,
        players: {},
        bullets: [],
        zoneRadius: MAP_SIZE * 0.75,
        status: 'waiting', // 'waiting' ou 'playing'
        winner: null
    };
}

// Cria 3 salas padrão no jogo
createRoom('sala-1', 'Arena Principal (BR)');
createRoom('sala-2', 'Ilha Sobrevivência');
createRoom('sala-3', 'Treino Livre');

function getRoomsSummary() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        name: r.name,
        count: Object.keys(r.players).length,
        max: MAX_PLAYERS,
        status: r.status
    }));
}

io.on('connection', (socket) => {
    // Envia lista de salas e o IP do servidor assim que conecta
    socket.emit('lobby_info', {
        rooms: getRoomsSummary(),
        serverIP: `${getLocalIP()}:3000`
    });

    socket.on('get_rooms', () => {
        socket.emit('rooms_update', getRoomsSummary());
    });

    // Entrar em uma sala
    socket.on('join_room', ({ roomId, nickname }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error_msg', 'Sala não encontrada.');
        if (Object.keys(room.players).length >= MAX_PLAYERS) {
            return socket.emit('error_msg', 'Sala lotada (50/50)!');
        }

        socket.join(roomId);
        socket.currentRoom = roomId;

        const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];

        room.players[socket.id] = {
            id: socket.id,
            name: (nickname || 'Jogador').substring(0, 14),
            x: Math.random() * (MAP_SIZE - 400) + 200,
            y: Math.random() * (MAP_SIZE - 400) + 200,
            angle: 0,
            hp: 3,
            alive: true,
            kills: 0,
            color: randomColor
        };

        // Se tiver 2 ou mais jogadores, ativa o modo Battle Royale
        const aliveCount = Object.values(room.players).filter(p => p.alive).length;
        if (aliveCount >= 2 && room.status === 'waiting') {
            room.status = 'playing';
            room.zoneRadius = MAP_SIZE * 0.75;
            room.winner = null;
        }

        socket.emit('joined', {
            playerId: socket.id,
            roomId: room.id,
            roomName: room.name,
            mapSize: MAP_SIZE
        });

        io.emit('rooms_update', getRoomsSummary());
    });

    // Movimento do jogador
    socket.on('move', ({ dx, dy, angle }) => {
        const room = rooms[socket.currentRoom];
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        const speed = 5.5;
        p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + dx * speed));
        p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + dy * speed));
        if (angle !== null) p.angle = angle;
    });

    // Disparo
    socket.on('shoot', () => {
        const room = rooms[socket.currentRoom];
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        // Limite simples de cadência (cooldown de 250ms)
        const now = Date.now();
        if (p.lastShot && now - p.lastShot < 250) return;
        p.lastShot = now;

        room.bullets.push({
            owner: socket.id,
            x: p.x + Math.cos(p.angle) * 28,
            y: p.y + Math.sin(p.angle) * 28,
            vx: Math.cos(p.angle) * 14,
            vy: Math.sin(p.angle) * 14,
            life: 60 // Dura 60 frames (~2 segundos)
        });
    });

    // Reiniciar partida na sala
    socket.on('restart_room', () => {
        const room = rooms[socket.currentRoom];
        if (!room) return;
        room.bullets = [];
        room.zoneRadius = MAP_SIZE * 0.75;
        room.winner = null;
        const ids = Object.keys(room.players);
        room.status = ids.length >= 2 ? 'playing' : 'waiting';

        for (let id of ids) {
            room.players[id].hp = 3;
            room.players[id].alive = true;
            room.players[id].kills = 0;
            room.players[id].x = Math.random() * (MAP_SIZE - 400) + 200;
            room.players[id].y = Math.random() * (MAP_SIZE - 400) + 200;
        }
    });

    // Sair da sala / Desconectar
    const leaveCurrentRoom = () => {
        const roomId = socket.currentRoom;
        if (!roomId || !rooms[roomId]) return;
        delete rooms[roomId].players[socket.id];
        socket.leave(roomId);
        socket.currentRoom = null;

        if (Object.keys(rooms[roomId].players).length === 0) {
            rooms[roomId].status = 'waiting';
            rooms[roomId].bullets = [];
            rooms[roomId].zoneRadius = MAP_SIZE * 0.75;
        }
        io.emit('rooms_update', getRoomsSummary());
    };

    socket.on('leave_room', leaveCurrentRoom);
    socket.on('disconnect', leaveCurrentRoom);
});

// Loop principal do jogo (30 ticks por segundo - ideal para 50 jogadores sem lag)
setInterval(() => {
    const center = MAP_SIZE / 2;

    for (let roomId in rooms) {
        const room = rooms[roomId];
        const playerList = Object.values(room.players);
        if (playerList.length === 0) continue;

        // Fecha a zona segura (gás) se a partida estiver rolando
        if (room.status === 'playing' && room.zoneRadius > 150) {
            room.zoneRadius -= 0.4;
        }

        // Atualiza balas e colisões
        for (let i = room.bullets.length - 1; i >= 0; i--) {
            const b = room.bullets[i];
            b.x += b.vx;
            b.y += b.vy;
            b.life--;

            if (b.life <= 0 || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
                room.bullets.splice(i, 1);
                continue;
            }

            for (let target of playerList) {
                if (target.alive && target.id !== b.owner) {
                    const dist = Math.hypot(b.x - target.x, b.y - target.y);
                    if (dist < 22) {
                        room.bullets.splice(i, 1);
                        target.hp -= 1;

                        if (target.hp <= 0) {
                            target.alive = false;
                            if (room.players[b.owner]) {
                                room.players[b.owner].kills += 1;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // Dano do gás (fora da zona segura) e checagem de vencedor
        let alivePlayers = [];
        for (let p of playerList) {
            if (p.alive) {
                const distFromCenter = Math.hypot(p.x - center, p.y - center);
                if (room.status === 'playing' && distFromCenter > room.zoneRadius) {
                    p.gasTick = (p.gasTick || 0) + 1;
                    if (p.gasTick >= 45) { // Toma 1 de dano a cada 1.5s no gás
                        p.hp -= 1;
                        p.gasTick = 0;
                        if (p.hp <= 0) p.alive = false;
                    }
                }
                if (p.alive) alivePlayers.push(p);
            }
        }

        // Verifica se sobrou apenas 1 vivo no modo Battle Royale
        if (room.status === 'playing' && alivePlayers.length <= 1 && playerList.length >= 2) {
            room.status = 'finished';
            room.winner = alivePlayers.length === 1 ? alivePlayers[0].name : 'Empate';
        }

        // Envia estado apenas para quem está dentro desta sala
        io.to(roomId).emit('state', {
            players: room.players,
            bullets: room.bullets,
            zoneRadius: room.zoneRadius,
            status: room.status,
            winner: room.winner,
            aliveCount: alivePlayers.length,
            totalCount: playerList.length
        });
    }
}, 1000 / 30);

server.listen(3000, '0.0.0.0', () => {
    console.log('====================================');
    console.log('Servidor Battle Royale rodando!');
    console.log(`Acesse no PC: http://localhost:3000`);
    console.log(`IP para Celular/Rede: ${getLocalIP()}:3000`);
    console.log('====================================');
});