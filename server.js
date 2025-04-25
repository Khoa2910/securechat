const express = require("express");
const mysql = require("mysql2/promise");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const CryptoJS = require("crypto-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// Kết nối MySQL
const dbConfig = {
    host: "localhost",
    user: "root",
    password: "",
    database: "securechat",
};

let db;

(async () => {
    db = await mysql.createConnection(dbConfig);
    console.log("MySQL connected");
})();

// Mã hóa tin nhắn
const SECRET_KEY = "my-secret-key";
const encryptMessage = (text) => {
    if (!text) return null;
    return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
};
const decryptMessage = (ciphertext) => {
    if (!ciphertext) return null;
    const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
};

// API đăng ký tài khoản
app.post("/api/register", async (req, res) => {
    const { email, name, password } = req.body;

    // Kiểm tra định dạng email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Email không đúng định dạng!" });
    }

    // Kiểm tra tên
    if (!name || name.trim() === "") {
        return res.status(400).json({ error: "Tên không được để trống!" });
    }

    // Kiểm tra mật khẩu
    if (password.length < 6) {
        return res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự!" });
    }

    try {
        // Kiểm tra email đã tồn tại
        const [existingUser] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
        if (existingUser.length > 0) {
            return res.status(400).json({ error: "Email đã được sử dụng!" });
        }

        // Tạo tài khoản
        await db.execute("INSERT INTO users (email, name, password) VALUES (?, ?, ?)", [email, name, password]);
        res.json({ message: "Đăng ký thành công!" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API đăng nhập
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        // Kiểm tra user
        const [users] = await db.execute("SELECT * FROM users WHERE email = ? AND password = ?", [email, password]);
        if (users.length === 0) {
            return res.status(401).json({ error: "Email hoặc mật khẩu không đúng!" });
        }

        const user = users[0];
        // Lấy danh sách bạn bè
        const [friends] = await db.execute(
            "SELECT friend_email FROM friends WHERE user_email = ?",
            [email]
        );

        // Lấy danh sách cuộc trò chuyện
        const [conversations] = await db.execute(
            `SELECT c.id, c.last_message, c.last_message_time, GROUP_CONCAT(cp.username) as participants
             FROM conversations c
             JOIN conversation_participants cp ON c.id = cp.conversation_id
             WHERE cp.username = ?
             GROUP BY c.id`,
            [email]
        );

        res.json({
            userId: user.id,
            email: user.email,
            name: user.name,
            friends: friends.map(f => f.friend_email),
            conversations: conversations.map(conv => ({
                _id: conv.id,
                participants: conv.participants.split(","),
                lastMessage: conv.last_message,
                lastMessageTime: conv.last_message_time,
            })),
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API tìm kiếm người dùng bằng email
app.get("/api/search/:email", async (req, res) => {
    const { email } = req.params;
    try {
        const [users] = await db.execute(
            "SELECT email, name FROM users WHERE email LIKE ?",
            [`%${email}%`]
        );
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API gửi yêu cầu kết bạn
app.post("/api/friend-request", async (req, res) => {
    const { senderEmail, receiverEmail } = req.body;
    try {
        // Kiểm tra xem đã gửi yêu cầu chưa
        const [existingRequest] = await db.execute(
            "SELECT * FROM friend_requests WHERE sender_email = ? AND receiver_email = ? AND status = 'pending'",
            [senderEmail, receiverEmail]
        );
        if (existingRequest.length > 0) {
            return res.status(400).json({ error: "Yêu cầu kết bạn đã được gửi!" });
        }

        // Kiểm tra xem đã là bạn chưa
        const [existingFriend] = await db.execute(
            "SELECT * FROM friends WHERE user_email = ? AND friend_email = ?",
            [senderEmail, receiverEmail]
        );
        if (existingFriend.length > 0) {
            return res.status(400).json({ error: "Hai người đã là bạn bè!" });
        }

        await db.execute(
            "INSERT INTO friend_requests (sender_email, receiver_email) VALUES (?, ?)",
            [senderEmail, receiverEmail]
        );
        io.emit("friendRequest", { senderEmail, receiverEmail });
        res.json({ message: "Gửi yêu cầu kết bạn thành công!" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API lấy danh sách yêu cầu kết bạn
app.get("/api/friend-requests/:email", async (req, res) => {
    const { email } = req.params;
    try {
        const [requests] = await db.execute(
            "SELECT fr.id, fr.sender_email, u.name as sender_name FROM friend_requests fr JOIN users u ON fr.sender_email = u.email WHERE fr.receiver_email = ? AND fr.status = 'pending'",
            [email]
        );
        res.json(requests);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API chấp nhận yêu cầu kết bạn
app.post("/api/accept-friend", async (req, res) => {
    const { requestId, userEmail, friendEmail } = req.body;
    try {
        await db.execute(
            "UPDATE friend_requests SET status = 'accepted' WHERE id = ?",
            [requestId]
        );
        await db.execute(
            "INSERT INTO friends (user_email, friend_email) VALUES (?, ?), (?, ?)",
            [userEmail, friendEmail, friendEmail, userEmail]
        );

        // Tạo cuộc trò chuyện mới
        const [result] = await db.execute(
            "INSERT INTO conversations (last_message, last_message_time) VALUES (?, ?)",
            ["Bắt đầu trò chuyện!", "10:00"]
        );
        const conversationId = result.insertId;
        await db.execute(
            "INSERT INTO conversation_participants (conversation_id, username) VALUES (?, ?), (?, ?)",
            [conversationId, userEmail, conversationId, friendEmail]
        );

        io.emit("friendAccepted", { userEmail, friendEmail, conversationId });
        res.json({ message: "Chấp nhận kết bạn thành công!" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API lấy danh sách tin nhắn
app.get("/api/messages/:chatId", async (req, res) => {
    const { chatId } = req.params;
    try {
        const [messages] = await db.execute("SELECT * FROM messages WHERE conversation_id = ?", [chatId]);
        const decryptedMessages = messages.map(msg => ({
            ...msg,
            text: decryptMessage(msg.text),
            hidden_text: decryptMessage(msg.hidden_text),
        }));
        res.json(decryptedMessages);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Socket.IO để truyền tin thời gian thực
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("joinChat", (chatId) => {
        socket.join(chatId);
    });

    socket.on("sendMessage", async (message) => {
        const encryptedText = encryptMessage(message.text);
        const encryptedHiddenText = encryptMessage(message.hiddenText);
        try {
            await db.execute(
                "INSERT INTO messages (conversation_id, text, sender, time, image, hidden_text) VALUES (?, ?, ?, ?, ?, ?)",
                [message.chatId, encryptedText, message.sender, message.time, message.image || null, encryptedHiddenText || null]
            );

            await db.execute(
                "UPDATE conversations SET last_message = ?, last_message_time = ? WHERE id = ?",
                [message.text || "Đã gửi một hình ảnh", message.time, message.chatId]
            );

            message.text = decryptMessage(encryptedText);
            message.hiddenText = decryptMessage(encryptedHiddenText);
            io.to(message.chatId).emit("receiveMessage", message);
        } catch (error) {
            console.error(error);
        }
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

server.listen(5000, () => console.log("Server running on port 5000"));