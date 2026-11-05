
const express = require("express");
const cors = require("cors");
const faceapi = require("face-api.js");
const canvas = require("canvas");
const fs = require("fs");
const path = require("path");
const { pool, initializeDatabase } = require("./db");
const auth = require("./auth");

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.post("/api/auth/login", auth.login);
app.post("/api/auth/logout", auth.requireAuth, async (req, res) => {
  await pool.query("DELETE FROM auth_sessions WHERE token=$1", [req.sessionToken]);
  res.json({ success: true });
});
app.use("/api/attendance", require("./attendanceRoutes"));
app.use("/api/leaves", require("./leaveRoutes"));
app.use("/api/employees", require("./employeeRoutes"));
app.use("/api/profile", require("./profileRoutes"));

// Face API canvas configuration
const { Canvas, Image, ImageData } = canvas;

faceapi.env.monkeyPatch({
  Canvas,
  Image,
  ImageData,
});

// File paths
const MODEL_PATH = path.join(__dirname, "models");
const DATA_FILE = path.join(__dirname, "faces.json");

// Registered face
let registeredFace = null;
let modelsLoaded = false;

// Initialize faces.json
function initializeFaceData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, "null", "utf8");
      registeredFace = null;
      return;
    }

    const fileData = fs.readFileSync(DATA_FILE, "utf8").trim();

    if (!fileData || fileData === "null") {
      registeredFace = null;
      fs.writeFileSync(DATA_FILE, "null", "utf8");
      return;
    }

    registeredFace = JSON.parse(fileData);

    if (
      !registeredFace ||
      !Array.isArray(registeredFace.descriptor) ||
      registeredFace.descriptor.length !== 128
    ) {
      console.warn("Invalid face data. Resetting.");
      registeredFace = null;
      fs.writeFileSync(DATA_FILE, "null", "utf8");
    }

    console.log(
      registeredFace
        ? "Registered face loaded successfully"
        : "No registered face found"
    );

  } catch (error) {
    console.error("Face data loading error:", error.message);

    registeredFace = null;
    fs.writeFileSync(DATA_FILE, "null", "utf8");
  }
}

initializeFaceData();

// Load face recognition models
async function loadModels() {
  console.log("Loading face recognition models...");

  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH);

  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH);

  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH);

  modelsLoaded = true;

  console.log("All face recognition models loaded successfully");
}

// Convert Base64 to image buffer
function getImageBuffer(base64Image) {
  if (!base64Image || typeof base64Image !== "string") {
    throw new Error("Face image is required");
  }

  const cleanBase64 = base64Image.replace(
    /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
    ""
  );

  const buffer = Buffer.from(cleanBase64, "base64");

  if (!buffer.length) {
    throw new Error("Invalid image data");
  }

  return buffer;
}

// Generate face descriptor
async function getFaceDescriptor(buffer) {
  const image = await canvas.loadImage(buffer);

  const detection = await faceapi
    .detectSingleFace(image)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    throw new Error(
      "No face detected. Please capture a clear face image."
    );
  }

  return Array.from(detection.descriptor);
}

// Store descriptors per employee; the comparison math remains unchanged.
async function saveFaceData(employeeId, data) {
  await pool.query(
    `INSERT INTO face_templates (employee_id, descriptor, registered_at)
     VALUES ($1, $2::DOUBLE PRECISION[], $3)
     ON CONFLICT (employee_id) DO UPDATE
       SET descriptor = EXCLUDED.descriptor, registered_at = EXCLUDED.registered_at`,
    [employeeId, data.descriptor, data.registeredAt]
  );
  registeredFace = data;
}

// Check models
function checkModels(req, res, next) {
  if (!modelsLoaded) {
    return res.status(503).json({
      success: false,
      message: "Face recognition models are not loaded yet.",
    });
  }

  next();
}

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Face Recognition API is running",
    modelsLoaded,
    faceRegistered: !!registeredFace,
    endpoints: [
      "POST /api/face/register",
      "POST /api/face/compare",
    ],
  });
});

app.get("/api/face/status", auth.requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT registered_at AS \"registeredAt\" FROM face_templates WHERE employee_id = $1",
      [req.employeeId]
    );
    res.json({ success: true, registered: rows.length > 0, registeredAt: rows[0]?.registeredAt || null });
  } catch (error) {
    console.error("Face status error:", error.message);
    res.status(500).json({ success: false, message: "Unable to load face registration status." });
  }
});

// API 1: Register Face
app.post(
  "/api/face/register",
  auth.requireAuth,
  checkModels,
  async (req, res) => {
    try {
      const imageBuffer = getImageBuffer(req.body.image);

      const descriptor = await getFaceDescriptor(imageBuffer);

      const faceData = {
        descriptor,
        registeredAt: new Date().toISOString(),
      };

      await saveFaceData(req.employeeId, faceData);

      return res.status(200).json({
        success: true,
        message: "Face registered successfully",
        registeredAt: faceData.registeredAt,
      });

    } catch (error) {
      console.error("Face registration error:", error.message);

      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// API 2: Compare Face
app.post(
  "/api/face/compare",
  auth.requireAuth,
  checkModels,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT descriptor FROM face_templates WHERE employee_id = $1",
        [req.employeeId]
      );
      if (!rows.length) {
        return res.status(400).json({
          success: false,
          matched: false,
          message: "No registered face found. Please register first.",
        });
      }

      const imageBuffer = getImageBuffer(req.body.image);

      const capturedDescriptor =
        await getFaceDescriptor(imageBuffer);

      const distance = faceapi.euclideanDistance(
        rows[0].descriptor,
        capturedDescriptor
      );

      const threshold = 0.4;

      const matched = distance < threshold;

      return res.status(200).json({
        success: true,
        matched,
        distance: Number(distance.toFixed(4)),
        threshold,
        message: matched
          ? "Face matched successfully"
          : "Face does not match",
      });

    } catch (error) {
      console.error("Face comparison error:", error.message);

      return res.status(400).json({
        success: false,
        matched: false,
        message: error.message,
      });
    }
  }
);

// Global error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  res.status(500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

// Start server
async function startServer() {
  try {
    await loadModels();
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log("----------------------------------");
      console.log("Face Recognition API Started");
      console.log(`Port: ${PORT}`);
      console.log(`Server: http://localhost:${PORT}`);
      console.log("----------------------------------");
    });

  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
