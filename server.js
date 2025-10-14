const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static("uploads"));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // if (
    //   file.mimetype.startsWith("image/") ||
    //   file.mimetype.startsWith("audio/")
    // )
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("audio/") ||
      file.mimetype === "application/pdf" || // <-- ADD THIS LINE
      file.mimetype.startsWith("video/") // (agar video bhi allow karna hai)
    )
      cb(null, true);
    else
      cb(
        new Error("Only image, audio, video, and PDF files are allowed!"),
        false
      );
  },
});

const MONGO_URI =
  "mongodb+srv://saurabhsaran474_db_user:kyWpgkxEHxdYoMcS@cluster0.qrnb4rf.mongodb.net/chatapp?retryWrites=true&w=majority&appName=Cluster0";
mongoose.connect(MONGO_URI);
mongoose.connection.on("connected", () => console.log("MongoDB connected"));
mongoose.connection.on("error", (err) =>
  console.log("MongoDB connection error", err)
);

// --- USER Schema changed ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  online: Boolean,
  lastChatTime: { type: Date, default: null }, // <-- Feature added
});
const User = mongoose.model("User", userSchema);

const messageSchema = new mongoose.Schema({
  from: String,
  to: String,
  message: String,
  messageType: {
    type: String,
    enum: ["text", "image", "voice", "doc", "video"],
    default: "text",
  },
  fileUrl: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model("Message", messageSchema);

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
  const token = jwt.sign({ username: user.username }, SECRET_KEY);
  res.json({ token, username: user.username });
});

// --- RECENT USERS ---
app.get("/users", async (req, res) => {
  const users = await User.find({}, "username online lastChatTime -_id").sort({
    lastChatTime: -1,
  });
  res.json(users);
});

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

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const fileUrl = `${req.protocol}://${req.get("host")}/${req.file.filename}`;
    res.json({
      success: true,
      fileUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
  } catch (error) {
    res.status(500).json({ error: "Upload failed" });
  }
  console.log("File body:", req.body);
  console.log("File info:", req.file);
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "File too large. Maximum size is 10MB." });
    }
  }
  res.status(500).json({ error: "Upload failed" });
});

// --- SOCKET.IO with recent logic ---
let onlineUsers = new Map();

io.on("connection", (socket) => {
  socket.on("userOnline", async (username) => {
    onlineUsers.set(username, socket.id);
    await User.updateOne({ username }, { online: true });
    io.emit("updateUserList", Array.from(onlineUsers.keys()));
  });

  socket.on("sendMessage", async (data) => {
    const { from, to, message, messageType = "text", fileUrl } = data;
    try {
      const newMsg = new Message({ from, to, message, messageType, fileUrl });
      await newMsg.save();

      // --- Update recent chat timestamp for both users ---
      const now = new Date();
      await User.updateOne({ username: from }, { $set: { lastChatTime: now } });
      await User.updateOne({ username: to }, { $set: { lastChatTime: now } });

      const messageData = {
        ...data,
        messageType,
        fileUrl,
        timestamp: newMsg.timestamp,
      };
      const toSocketId = onlineUsers.get(to);
      if (toSocketId) io.to(toSocketId).emit("receiveMessage", messageData);
      socket.emit("receiveMessage", messageData);
    } catch (error) {
      socket.emit("error", { message: "Failed to send message" });
    }
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
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
