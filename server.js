const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- PRIPOJENIE K MONGODB ATLAS ---
const mongoURI = process.env.MONGO_URI;

if (mongoURI) {
    mongoose.connect(mongoURI)
        .then(() => console.log('✅ Úspešne pripojené k MongoDB Atlas!'))
        .catch(err => console.error('❌ Chyba pripojenia k MongoDB:', err));
} else {
    console.warn('⚠️ Varovanie: MONGO_URI premenná nebola nájdená!');
}

// Schéma používateľa pre MongoDB
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    usernameLower: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    profile: {
        gender: { type: String, default: 'male' },
        age: { type: String, default: '' },
        city: { type: String, default: '' },
        about: { type: String, default: 'Ahoj!' },
        avatar: { type: String, default: '' }
    }
});

const User = mongoose.model('User', userSchema);

// Pole pre uchovanie histórie verejných správ v pamäti
let historiaSprav = [];
const activeUsers = {};

// Pomocná funkcia na odoslanie aktualizovaného zoznamu aktívnych používateľov
async function broadcastActiveUsers() {
    const activeList = [];
    for (const u of Object.values(activeUsers)) {
        const dbUser = await User.findOne({ usernameLower: u.username.toLowerCase() });
        activeList.push({
            username: u.username,
            gender: dbUser?.profile?.gender || 'male',
            avatar: dbUser?.profile?.avatar || ''
        });
    }
    io.emit('update userlist', activeList);
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

        const newUser = new User({
            username: username,
            usernameLower: lower,
            password: hashedPassword,
            profile: {
                gender: gender || 'male',
                age: '',
                city: '',
                about: 'Ahoj!',
                avatar: ''
            }
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

        const user = await User.findOne({ usernameLower: username.toLowerCase() });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.json({ success: false, message: "Nesprávne meno alebo heslo" });
        }

        res.json({ success: true, username: user.username, profile: user.profile });
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
            await broadcastActiveUsers();

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
        socket.username = username;
        activeUsers[socket.id] = { username, socketId: socket.id };

        await broadcastActiveUsers();

        socket.emit('chat history', historiaSprav);

        socket.emit('chat message', { 
            user: 'Systém', 
            text: `Vitaj v Globtel Chate, ${username}!`,
            time: new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })
        });

        socket.emit('chat message', { 
            user: 'Podpora', 
            text: `Páči sa ti náš chat? Podpor jeho prevádzku a vývoj dobrovoľným príspevkom na: buymeacoffee.com/globtelchat ☕❤️`,
            time: new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })
        });
    });

    // POSLANIE NOVEJ FOTKY/AVATARA
    socket.on('change avatar', async (avatarUrl) => {
        if (!socket.username) return;

        const user = await User.findOne({ usernameLower: socket.username.toLowerCase() });
        if (user) {
            if (!user.profile) user.profile = {};
            user.profile.avatar = avatarUrl;
            await user.save();

            await broadcastActiveUsers();
        }
    });

    // ZOBRAZENIE PROFILOVEJ KARTY
    socket.on('get profile', async (targetName) => {
        if (!targetName) return;
        const user = await User.findOne({ usernameLower: targetName.toLowerCase() });
        if (user) {
            socket.emit('view profile card', {
                username: user.username,
                profile: user.profile
            });
        }
    });

    // NAČÍTANIE PROFILU PRE HOVER MINIKARTU (POKEC ŠTÝL)
    socket.on('get hover profile', async (targetName) => {
        if (!targetName) return;
        const user = await User.findOne({ usernameLower: targetName.toLowerCase() });
        if (user) {
            socket.emit('show hover profile', {
                username: user.username,
                profile: user.profile
            });
        }
    });

    // SPRÁVY (Verejné aj Súkromné)
    socket.on('chat message', async (msgData) => {
        if (!socket.username) return;

        const user = await User.findOne({ usernameLower: socket.username.toLowerCase() });
        const userAvatar = user?.profile?.avatar || '';

        const cas = new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });

        let text = typeof msgData === 'object' ? msgData.text : msgData;
        let recipient = typeof msgData === 'object' ? msgData.recipient : null;

        if (!text || text.trim() === '') return;
        text = text.trim();

        // SÚKROMNÁ SPRÁVA
        if (recipient && recipient !== 'global') {
            const recipientSocketId = Object.keys(activeUsers).find(
                id => activeUsers[id].username.toLowerCase() === recipient.toLowerCase()
            );

            const privateMsg = {
                user: socket.username,
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
        // VEREJNÁ SPRÁVA
        else {
            const spravaObjekt = { 
                user: socket.username, 
                avatar: userAvatar,
                text: text,
                time: cas,
                isPrivate: false
            };

            historiaSprav.push(spravaObjekt);
            if (historiaSprav.length > 50) historiaSprav.shift();

            io.emit('chat message', spravaObjekt);
        }
    });

    socket.on('disconnect', async () => {
        if (socket.username) {
            delete activeUsers[socket.id];
            await broadcastActiveUsers();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Globtel Chat beží na porte ${PORT} 🚀`);
});