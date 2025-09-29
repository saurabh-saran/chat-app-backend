const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGO_URI =
  "mongodb+srv://saurabhsaran474_db_user:kyWpgkxEHxdYoMcS@cluster0.qrnb4rf.mongodb.net/chatapp?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI);
mongoose.connection.on("connected", () => console.log("MongoDB connected"));
mongoose.connection.on("error", (err) =>
  console.log("MongoDB connection error", err)
);

// Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  online: Boolean,
});
const User = mongoose.model("User", userSchema);

const messageSchema = new mongoose.Schema({
  from: String,
  to: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model("Message", messageSchema);

// Secret Key
const SECRET_KEY = "your_secret_key";

// Signup route
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPass = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPass, online: false });
    await newUser.save();
    res.status(201).send("User created");
  } catch (err) {
    res.status(400).send("Username already exists");
  }
});

// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.status(400).send("Invalid credentials");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).send("Invalid credentials");

  user.online = true;
  await user.save();

  // JWT token generate (optional)
  const token = jwt.sign({ username: user.username }, SECRET_KEY);

  res.json({ token, username: user.username });
});

// Get all users for UserList
app.get("/users", async (req, res) => {
  const users = await User.find({}, "username online -_id");
  res.json(users);
});

// Get chat history between two users
app.get("/messages", async (req, res) => {
  const { from, to } = req.query;
  const messages = await Message.find({
    $or: [
      { from, to },
      { from: to, to: from },
    ],
  }).sort({ timestamp: 1 });
  res.json(messages);
});

// Socket.IO for realtime chat
let onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log("New user connected with id:", socket.id);

  socket.on("userOnline", async (username) => {
    onlineUsers.set(username, socket.id);
    await User.updateOne({ username }, { online: true });
    io.emit("updateUserList", Array.from(onlineUsers.keys()));
  });

  socket.on("sendMessage", async (data) => {
    const { from, to, message } = data;
    const newMsg = new Message({ from, to, message });
    await newMsg.save();

    const toSocketId = onlineUsers.get(to);
    if (toSocketId) {
      io.to(toSocketId).emit("receiveMessage", data);
    }
    socket.emit("receiveMessage", data);
  });

  socket.on("disconnect", async () => {
    for (let [username, sid] of onlineUsers.entries()) {
      if (sid === socket.id) {
        onlineUsers.delete(username);
        await User.updateOne({ username }, { online: false });
        io.emit("updateUserList", Array.from(onlineUsers.keys()));
        break;
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
