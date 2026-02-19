require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const connectDB = require("./utils/db");

//Routes
const authRoutes = require('./routes/authRoute');
const projectRoutes = require('./routes/projectRoute');
const installationRoutes = require('./routes/installationRoute');
const sessionRoutes = require('./routes/sessionRoute');



connectDB();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 3000;

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/installation", installationRoutes);
app.use("/api", sessionRoutes);

// Serve tracker.js
app.get("/tracker.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(__dirname + "/tracker.js");
});

app.listen(PORT, () =>{
    console.log("Watching on 3000...");
    
});