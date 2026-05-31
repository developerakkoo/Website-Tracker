const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../modal/user");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function userPayload(user) {
  return {
    id: user._id.toString(),
    email: user.email
  };
}

function validateCredentials(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ message: "Email and password are required" });
    return null;
  }
  return { email: String(email).trim().toLowerCase(), password };
}

// Register
router.post("/register", async (req, res) => {
  try {
    const creds = validateCredentials(req, res);
    if (!creds) return;

    const hashedPassword = await bcrypt.hash(creds.password, 10);

    const user = new User({
      email: creds.email,
      password: hashedPassword
    });

    await user.save();

    const token = signToken(user._id);
    return res.status(201).json({
      token,
      user: userPayload(user)
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Email already registered" });
    }
    console.error("Register error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const creds = validateCredentials(req, res);
    if (!creds) return;

    const user = await User.findOne({ email: creds.email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(creds.password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const token = signToken(user._id);
    return res.json({
      token,
      user: userPayload(user)
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Reset password (no email verification — email + new password only)
router.post("/reset-password", async (req, res) => {
  try {
    const creds = validateCredentials(req, res);
    if (!creds) return;

    const user = await User.findOne({ email: creds.email });
    if (!user) {
      return res.status(404).json({ message: "No account found with this email" });
    }

    user.password = await bcrypt.hash(creds.password, 10);
    await user.save();

    return res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Current user (protected)
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email");
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    return res.json(userPayload(user));
  } catch (err) {
    console.error("Auth me error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
