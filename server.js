const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const USER_DB_PATH = path.join(__dirname, 'database', 'users.json');

// Pole pre uchovanie histórie verejných správ
let historiaSprav = [];

function loadUsers() {
    if (!fs.existsSync(USER_DB_PATH)) {
        const dir = path.dirname(USER_DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(USER_DB_PATH, JSON.stringify({}));
    }
    try {
        return JSON.parse(fs.readFileSync(USER_DB_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveUsers(users) {
    fs.writeFileSync(USER_DB_PATH, JSON.stringify(users, null, 2));
}

const activeUsers = {};

app.post('/api/register', async (req, res) => {
    const { username, password, gender } = req.body;
    const users = loadUsers();

    if (!username || !password) return res.json({ success: false, message: "Fill all fields" });
    if (users[username.toLowerCase()]) return res.json({ success: false, message: "Username taken!" });

    const hashedPassword = await bcrypt.hash(password, 10);
    
    users[username.toLowerCase()] = {
        username: username,
        password: hashedPassword,
        profile: {
            gender: gender || 'male',
            age: '',
            city: '',
            about: 'Ahoj!',
            avatar: '' // Predvolený prázdny avatar
        }
    };

    saveUsers(users);
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
    const user = users[username?.toLowerCase()];

    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.json({ success: false, message: "Invalid username or password" });
    }

    res.json({ success: true, username: user.username, profile: user.profile });
});

app.post('/api/profile/update', (req, res) => {
    const { username, age, city, about, gender } = req.body;
    const users = loadUsers();
    const userKey = username?.toLowerCase();

    if (userKey && users[userKey]) {
        const currentProfile = users[userKey].profile || {};
        
        users[userKey].profile = {
            gender: gender || currentProfile.gender || 'male',
            age: age !== undefined ? age : currentProfile.age || '',
            city: city !== undefined ? city : currentProfile.city || '',
            about: about !== undefined ? about : currentProfile.about || '',
            avatar: currentProfile.avatar || ''
        };
        
        saveUsers(users);
        
        const activeList = Object.values(activeUsers).map(u => ({
            username: u.username,
            gender: users[u.username.toLowerCase()]?.profile?.gender || 'male',
            avatar: users[u.username.toLowerCase()]?.profile?.avatar || ''
        }));
        io.emit('update userlist', activeList);

        return res.json({ success: true, profile: users[userKey].profile });
    }
    res.json({ success: false, message: "User not found" });
});

io.on('connection', (socket) => {
    socket.on('user logged in', (username) => {
        if (!username) return;
        socket.username = username;
        activeUsers[socket.id] = { username, socketId: socket.id };

        const users = loadUsers();
        const activeList = Object.values(activeUsers).map(u => ({
            username: u.username,
            gender: users[u.username.toLowerCase()]?.profile?.gender || 'male',
            avatar: users[u.username.toLowerCase()]?.profile?.avatar || ''
        }));

        io.emit('update userlist', activeList);
        
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
    socket.on('change avatar', (avatarUrl) => {
        if (!socket.username) return;

        const users = loadUsers();
        const userKey = socket.username.toLowerCase();

        if (users[userKey]) {
            if (!users[userKey].profile) users[userKey].profile = {};
            users[userKey].profile.avatar = avatarUrl;
            saveUsers(users);

            // Aktualizujeme zoznam aktívnych používateľov s novou fotkou
            const activeList = Object.values(activeUsers).map(u => ({
                username: u.username,
                gender: users[u.username.toLowerCase()]?.profile?.gender || 'male',
                avatar: users[u.username.toLowerCase()]?.profile?.avatar || ''
            }));

            io.emit('update userlist', activeList);
        }
    });

    socket.on('get profile', (targetName) => {
        if (!targetName) return;
        const users = loadUsers();
        const targetUser = users[targetName.toLowerCase()];
        if (targetUser) {
            socket.emit('view profile card', {
                username: targetUser.username,
                profile: targetUser.profile
            });
        }
    });

    // SPRÁVY (Verejné aj Súkromné)
    socket.on('chat message', (msgData) => {
        if (!socket.username) return;

        const users = loadUsers();
        const currentUser = users[socket.username.toLowerCase()];
        const userAvatar = currentUser?.profile?.avatar || '';

        const cas = new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });

        let text = typeof msgData === 'object' ? msgData.text : msgData;
        let recipient = typeof msgData === 'object' ? msgData.recipient : null;

        if (!text || text.trim() === '') return;
        text = text.trim();

        // AK JE TO SÚKROMNÁ SPRÁVA
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

    socket.on('disconnect', () => {
        if (socket.username) {
            delete activeUsers[socket.id];
            const users = loadUsers();
            const activeList = Object.values(activeUsers).map(u => ({
                username: u.username,
                gender: users[u.username.toLowerCase()]?.profile?.gender || 'male',
                avatar: users[u.username.toLowerCase()]?.profile?.avatar || ''
            }));
            io.emit('update userlist', activeList);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Globtel Chat beží na porte ${PORT} 🚀`);
});