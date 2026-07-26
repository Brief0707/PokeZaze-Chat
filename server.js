const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- PRIIPOJENIE K MONGODB ATLAS ---
const mongoURI = process.env.MONGO_URI;

if (mongoURI) {
    mongoose.connect(mongoURI)
        .then(() => console.log('✅ Úspešne pripojené k MongoDB Atlas!'))
        .catch(err => console.error('❌ Chyba pripojenia k MongoDB:', err));
} else {
    console.warn('⚠️ Varovanie: MONGO_URI premenná nebola nájdená!');
}

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    usernameLower: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user' },
    isBanned: { type: Boolean, default: false },
    profile: {
        gender: { type: String, default: 'male' },
        age: { type: String, default: '' },
        city: { type: String, default: '' },
        about: { type: String, default: 'Ahoj!' },
        avatar: { type: String, default: '' }
    }
});

const User = mongoose.model('User', userSchema);

// História správ pre jednotlivé miestnosti
const historiaSprav = {
    global: [],
    zoznamka: [],
    pohody: [],
    caffe: []
};

const activeUsers = {};

// Pomocná funkcija na rozoslanie zoznamu online ľudí podľa miestností
function broadcastActiveUsers(room) {
    if (room) {
        const activeList = Object.values(activeUsers)
            .filter(u => u.room === room)
            .map(u => ({
                username: u.username,
                role: u.role,
                gender: u.gender,
                avatar: u.avatar
            }));
        io.to(room).emit('update userlist', activeList);
    } else {
        const miestnosti = ['global', 'zoznamka', 'pohody', 'caffe'];
        miestnosti.forEach(r => broadcastActiveUsers(r));
    }
}

// --- REGISTRÁCIA ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, gender } = req.body;
        if (!username || !password) {
            return res.json({ success: false, message: "Vyplň všetky polia" });
        }

        const lower = username.toLowerCase();
        const existingUser = await User.findOne({ usernameLower: lower });
        
        if (existingUser) {
            return res.json({ success: false, message: "Meno je už obsadené!" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const isAdmin = lower === 'admin';

        const newUser = new User({
            username: username,
            usernameLower: lower,
            password: hashedPassword,
            role: isAdmin ? 'admin' : 'user',
            isBanned: false,
            profile: { gender: gender || 'male', age: '', city: '', about: 'Ahoj!', avatar: '' }
        });

        await newUser.save();
        res.json({ success: true });
    } catch (err) {
        console.error("Chyba registrácie:", err);
        res.json({ success: false, message: "Chyba na serveri" });
    }
});

// --- PRIHLÁSENIE ---
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.json({ success: false, message: "Nesprávne prihlasovacie údaje" });
        }

        const lower = username.toLowerCase();
        const user = await User.findOne({ usernameLower: lower });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.json({ success: false, message: "Nesprávne meno alebo heslo" });
        }

        if (user.isBanned) {
            return res.json({ success: false, message: "Tvoj účet bol zablokovaný (BAN)!" });
        }

        if (lower === 'admin' && user.role !== 'admin') {
            user.role = 'admin';
            await user.save();
        }

        res.json({ success: true, username: user.username, role: user.role, profile: user.profile });
    } catch (err) {
        console.error("Chyba prihlásenia:", err);
        res.json({ success: false, message: "Chyba na serveri" });
    }
});

// --- ÚPRAVA PROFILU ---
app.post('/api/profile/update', async (req, res) => {
    try {
        const { username, age, city, about, gender } = req.body;
        const userKey = username?.toLowerCase();

        if (!userKey) return res.json({ success: false, message: "Používateľ nenájdený" });

        const user = await User.findOne({ usernameLower: userKey });

        if (user) {
            if (!user.profile) user.profile = {};
            if (gender !== undefined) user.profile.gender = gender;
            if (age !== undefined) user.profile.age = age;
            if (city !== undefined) user.profile.city = city;
            if (about !== undefined) user.profile.about = about;

            await user.save();

            for (const socketId in activeUsers) {
                if (activeUsers[socketId].username.toLowerCase() === userKey) {
                    activeUsers[socketId].gender = user.profile.gender;
                    break;
                }
            }

            broadcastActiveUsers();
            return res.json({ success: true, profile: user.profile });
        }
        res.json({ success: false, message: "Používateľ nenájdený" });
    } catch (err) {
        console.error("Chyba pri úprave profilu:", err);
        res.json({ success: false, message: "Chyba na serveri" });
    }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {

    socket.on('user logged in', async (username) => {
        if (!username) return;

        const dbUser = await User.findOne({ usernameLower: username.toLowerCase() });
        if (dbUser && dbUser.isBanned) {
            socket.emit('banned out');
            return;
        }

        socket.username = dbUser ? dbUser.username : username;
        socket.role = dbUser?.role || 'user';
        let defaultRoom = 'global';

        socket.join(defaultRoom);

        activeUsers[socket.id] = { 
            username: socket.username, 
            role: socket.role, 
            gender: dbUser?.profile?.gender || 'male',
            avatar: dbUser?.profile?.avatar || '',
            room: defaultRoom,
            socketId: socket.id 
        };

        broadcastActiveUsers(defaultRoom);

        socket.emit('chat history', historiaSprav[defaultRoom]);

        socket.emit('chat message', { 
            user: 'Systém', 
            text: `Vitaj v Globtel Chate, ${socket.username}!`,
            time: getFormattedTime()
        });

        socket.emit('chat message', { 
            user: 'Podpora', 
            text: `Páči sa ti náš chat? Podpor jeho prevádzku a vývoj dobrovoľným príspevkom na: buymeacoffee.com/globtelchat ☕❤️`,
            time: getFormattedTime()
        });
    });

    // PREPÍNANIE MIESTNOSTÍ
    socket.on('switch room', (newRoom) => {
        if (!socket.username || !['global', 'zoznamka', 'pohody', 'caffe'].includes(newRoom)) return;

        const oldRoom = activeUsers[socket.id]?.room || 'global';
        socket.leave(oldRoom);
        socket.join(newRoom);

        if (activeUsers[socket.id]) {
            activeUsers[socket.id].room = newRoom;
        }

        broadcastActiveUsers(oldRoom);
        broadcastActiveUsers(newRoom);

        socket.emit('chat history', historiaSprav[newRoom] || []);
    });

    // ADMIN PRÍKAZY
    socket.on('admin kick user', async (targetUsername) => {
        if (socket.role !== 'admin') return;

        const targetSocketId = Object.keys(activeUsers).find(
            id => activeUsers[id].username.toLowerCase() === targetUsername.toLowerCase()
        );

        if (targetSocketId) {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            const userRoom = activeUsers[targetSocketId]?.room;
            if (targetSocket) {
                targetSocket.emit('kicked out');
                targetSocket.disconnect(true);
            }

            delete activeUsers[targetSocketId];
            if (userRoom) broadcastActiveUsers(userRoom);

            io.emit('chat message', {
                user: 'Systém',
                text: `Používateľ ${targetUsername} bol vyhodený z chatu.`,
                time: getFormattedTime()
            });
        }
    });

    socket.on('admin ban user', async (targetUsername) => {
        if (socket.role !== 'admin') return;

        await User.updateOne({ usernameLower: targetUsername.toLowerCase() }, { isBanned: true });

        const targetSocketId = Object.keys(activeUsers).find(
            id => activeUsers[id].username.toLowerCase() === targetUsername.toLowerCase()
        );

        if (targetSocketId) {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            const userRoom = activeUsers[targetSocketId]?.room;
            if (targetSocket) {
                targetSocket.emit('banned out');
                targetSocket.disconnect(true);
            }

            delete activeUsers[targetSocketId];
            if (userRoom) broadcastActiveUsers(userRoom);
        }

        io.emit('chat message', {
            user: 'Systém',
            text: `Používateľ ${targetUsername} bol zablokovaný (BAN).`,
            time: getFormattedTime()
        });
    });

    socket.on('change avatar', async (avatarUrl) => {
        if (!socket.username) return;

        const user = await User.findOne({ usernameLower: socket.username.toLowerCase() });
        if (user) {
            if (!user.profile) user.profile = {};
            user.profile.avatar = avatarUrl;
            await user.save();

            if (activeUsers[socket.id]) {
                activeUsers[socket.id].avatar = avatarUrl;
                broadcastActiveUsers(activeUsers[socket.id].room);
            }
        }
    });

    socket.on('get profile', async (targetName) => {
        if (!targetName) return;
        const user = await User.findOne({ usernameLower: targetName.toLowerCase() });
        if (user) {
            socket.emit('view profile card', { username: user.username, role: user.role, profile: user.profile });
        }
    });

    socket.on('get hover profile', async (targetName) => {
        if (!targetName) return;
        const user = await User.findOne({ usernameLower: targetName.toLowerCase() });
        if (user) {
            socket.emit('show hover profile', { username: user.username, role: user.role, profile: user.profile });
        }
    });

    // SPRÁVY (Verejné v miestnosti / Súkromné)
    socket.on('chat message', async (msgData) => {
        if (!socket.username) return;

        const user = await User.findOne({ usernameLower: socket.username.toLowerCase() });
        if (user?.isBanned) return;

        const userAvatar = user?.profile?.avatar || '';
        const userRole = user?.role || 'user';
        const cas = getFormattedTime();

        let text = typeof msgData === 'object' ? msgData.text : msgData;
        let recipient = typeof msgData === 'object' ? msgData.recipient : null;

        if (!text || text.trim() === '') return;
        text = text.trim();

        // SÚKROMNÁ SPRÁVA (RP)
        if (recipient && recipient !== 'global') {
            const recipientSocketId = Object.keys(activeUsers).find(
                id => activeUsers[id].username.toLowerCase() === recipient.toLowerCase()
            );

            const privateMsg = {
                user: socket.username,
                role: userRole,
                avatar: userAvatar,
                text: text,
                time: cas,
                isPrivate: true,
                target: recipient
            };

            if (recipientSocketId) {
                io.to(recipientSocketId).emit('chat message', privateMsg);
                socket.emit('chat message', privateMsg);
            } else {
                socket.emit('chat message', {
                    user: 'Systém',
                    text: `Používateľ ${recipient} už nie je online.`,
                    time: cas
                });
            }
        } 
        // VEREJNÁ SPRÁVA V DANEJ MIESTNOSTI
        else {
            const currentRoom = activeUsers[socket.id]?.room || 'global';
            const spravaObjekt = { 
                user: socket.username, 
                role: userRole,
                avatar: userAvatar,
                text: text,
                time: cas,
                isPrivate: false
            };

            if (!historiaSprav[currentRoom]) historiaSprav[currentRoom] = [];
            historiaSprav[currentRoom].push(spravaObjekt);
            if (historiaSprav[currentRoom].length > 50) historiaSprav[currentRoom].shift();

            io.to(currentRoom).emit('chat message', spravaObjekt);
        }
    });

    socket.on('disconnect', () => {
        if (socket.id && activeUsers[socket.id]) {
            const userRoom = activeUsers[socket.id].room;
            delete activeUsers[socket.id];
            if (userRoom) broadcastActiveUsers(userRoom);
        }
    });
});

function getFormattedTime() {
    return new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Globtel Chat beží na porte ${PORT} 🚀`);
});