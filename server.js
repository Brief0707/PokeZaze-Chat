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

// --- MONGODB ATLAS CONNECTION ---
const mongoURI = process.env.MONGO_URI;

if (mongoURI) {
    mongoose.connect(mongoURI)
        .then(() => console.log('✅ Successfully connected to MongoDB Atlas!'))
        .catch(err => console.error('❌ MongoDB connection error:', err));
} else {
    console.warn('⚠️ Warning: MONGO_URI environment variable not found!');
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
        about: { type: String, default: 'Hello!' },
        avatar: { type: String, default: '' }
    }
});

const User = mongoose.model('User', userSchema);

// Message history for each room
const messageHistory = {
    dating: [],
    chill: [],
    caffe: [],
    sports: [],
    music: [],
    foreign: []
};

const activeUsers = {};

// Helper function to broadcast active users list per room
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
        const rooms = ['dating', 'chill', 'caffe', 'sports', 'music', 'foreign'];
        rooms.forEach(r => broadcastActiveUsers(r));
    }
}

// --- REGISTRATION ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, gender } = req.body;
        if (!username || !password) {
            return res.json({ success: false, message: "Please fill in all fields" });
        }

        const lower = username.toLowerCase();
        const existingUser = await User.findOne({ usernameLower: lower });
        
        if (existingUser) {
            return res.json({ success: false, message: "Username is already taken!" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const isAdmin = lower === 'admin';

        const newUser = new User({
            username: username,
            usernameLower: lower,
            password: hashedPassword,
            role: isAdmin ? 'admin' : 'user',
            isBanned: false,
            profile: { gender: gender || 'male', age: '', city: '', about: 'Hello!', avatar: '' }
        });

        await newUser.save();
        res.json({ success: true });
    } catch (err) {
        console.error("Registration error:", err);
        res.json({ success: false, message: "Server error" });
    }
});

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.json({ success: false, message: "Invalid credentials" });
        }

        const lower = username.toLowerCase();
        const user = await User.findOne({ usernameLower: lower });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.json({ success: false, message: "Incorrect username or password" });
        }

        if (user.isBanned) {
            return res.json({ success: false, message: "Your account has been banned!" });
        }

        if (lower === 'admin' && user.role !== 'admin') {
            user.role = 'admin';
            await user.save();
        }

        res.json({ success: true, username: user.username, role: user.role, profile: user.profile });
    } catch (err) {
        console.error("Login error:", err);
        res.json({ success: false, message: "Server error" });
    }
});

// --- PROFILE UPDATE ---
app.post('/api/profile/update', async (req, res) => {
    try {
        const { username, age, city, about, gender } = req.body;
        const userKey = username?.toLowerCase();

        if (!userKey) return res.json({ success: false, message: "User not found" });

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
        res.json({ success: false, message: "User not found" });
    } catch (err) {
        console.error("Profile update error:", err);
        res.json({ success: false, message: "Server error" });
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
        let defaultRoom = 'dating';

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

        socket.emit('chat history', messageHistory[defaultRoom]);
    });

    // SWITCH ROOMS
    socket.on('switch room', (newRoom) => {
        const allowedRooms = ['dating', 'chill', 'caffe', 'sports', 'music', 'foreign'];
        if (!socket.username || !allowedRooms.includes(newRoom)) return;

        const oldRoom = activeUsers[socket.id]?.room || 'dating';
        socket.leave(oldRoom);
        socket.join(newRoom);

        if (activeUsers[socket.id]) {
            activeUsers[socket.id].room = newRoom;
        }

        broadcastActiveUsers(oldRoom);
        broadcastActiveUsers(newRoom);

        socket.emit('chat history', messageHistory[newRoom] || []);
    });

    // ADMIN COMMANDS
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
                user: 'System',
                text: `User ${targetUsername} has been kicked from the chat.`,
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
            user: 'System',
            text: `User ${targetUsername} has been banned.`,
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

    // MESSAGES (Public in room / Private DM)
    socket.on('chat message', async (msgData) => {
        if (!socket.username) return;

        const user = await User.findOne({ usernameLower: socket.username.toLowerCase() });
        if (user?.isBanned) return;

        const userAvatar = user?.profile?.avatar || '';
        const userRole = user?.role || 'user';
        const timeStr = getFormattedTime();

        let text = typeof msgData === 'object' ? msgData.text : msgData;
        let recipient = typeof msgData === 'object' ? msgData.recipient : null;

        if (!text || text.trim() === '') return;
        text = text.trim();

        // PRIVATE MESSAGE (DM)
        if (recipient && recipient !== 'global') {
            const recipientSocketId = Object.keys(activeUsers).find(
                id => activeUsers[id].username.toLowerCase() === recipient.toLowerCase()
            );

            const privateMsg = {
                user: socket.username,
                role: userRole,
                avatar: userAvatar,
                text: text,
                time: timeStr,
                isPrivate: true,
                target: recipient
            };

            if (recipientSocketId) {
                io.to(recipientSocketId).emit('chat message', privateMsg);
                socket.emit('chat message', privateMsg);
            } else {
                socket.emit('chat message', {
                    user: 'System',
                    text: `User ${recipient} is no longer online.`,
                    time: timeStr
                });
            }
        } 
        // PUBLIC MESSAGE IN ROOM
        else {
            const currentRoom = activeUsers[socket.id]?.room || 'dating';
            const messageObject = { 
                user: socket.username, 
                role: userRole,
                avatar: userAvatar,
                text: text,
                time: timeStr,
                isPrivate: false
            };

            if (!messageHistory[currentRoom]) messageHistory[currentRoom] = [];
            messageHistory[currentRoom].push(messageObject);
            if (messageHistory[currentRoom].length > 50) messageHistory[currentRoom].shift();

            io.to(currentRoom).emit('chat message', messageObject);
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
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Globtel Chat is running on port ${PORT} 🚀`);
});
```[cite: 8]
