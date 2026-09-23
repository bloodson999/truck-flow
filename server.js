require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const connectDB = require("./db");
const Shipment = require("./models/Shipment");
const geocode = require("./utils/geocode");
const getRoute = require("./utils/routeEngine");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const intervals = {};
const moveLocks = new Set();

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
const adminTokens = new Set();

const TICK_MS = Math.max(1000, Number(process.env.MOVE_TICK_MS || 5000));
const POINT_STEP = Math.max(1, Number(process.env.MOVE_POINT_STEP || 1));

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

function formatShipment(shipment) {
  return {
    id: shipment.trackingId,
    trackingId: shipment.trackingId,
    senderName: shipment.senderName || "",
    receiverName: shipment.receiverName || "",
    pickup: shipment.pickupText,
    drop: shipment.dropText,
    pickupPoint: shipment.pickup,
    dropPoint: shipment.drop,
    weight: shipment.weight,
    truckType: shipment.truckType,
    status: shipment.status,
    pauseReason: shipment.pauseReason || "",
    history: shipment.history,
    location: shipment.location,
    routeIndex: shipment.routeIndex
  };
}

function clearShipmentInterval(id) {
  if (intervals[id]) {
    clearInterval(intervals[id]);
    delete intervals[id];
  }
}

async function moveShipment(id) {
  if (moveLocks.has(id)) return;
  moveLocks.add(id);

  try {
    const shipment = await Shipment.findOne({ trackingId: id });
    if (!shipment) {
      clearShipmentInterval(id);
      return;
    }

    const pathPoints = Array.isArray(shipment.route) ? shipment.route : [];
    if (pathPoints.length === 0) {
      clearShipmentInterval(id);
      return;
    }

    let idx = Number(shipment.routeIndex || 0);

    if (idx >= pathPoints.length - 1) {
      shipment.status = "Delivered";
      await shipment.save();
      clearShipmentInterval(id);
      console.log(`📦 ${id} DELIVERED`);
      return;
    }

    idx = Math.min(idx + POINT_STEP, pathPoints.length - 1);
    const nextPoint = pathPoints[idx];

    shipment.routeIndex = idx;
    shipment.location = nextPoint;
    shipment.history.push(nextPoint);
    shipment.status = idx >= pathPoints.length - 1 ? "Delivered" : "In Transit";

    await shipment.save();

    console.log(`🚛 ${id} → ${nextPoint.lat.toFixed(4)}, ${nextPoint.lng.toFixed(4)}`);

    if (idx >= pathPoints.length - 1) {
      clearShipmentInterval(id);
      console.log(`📦 ${id} DELIVERED`);
    }
  } finally {
    moveLocks.delete(id);
  }
}

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/tracking", (_req, res) => res.sendFile(path.join(__dirname, "public", "tracking.html")));
app.get("/booking", (_req, res) => res.sendFile(path.join(__dirname, "public", "booking.html")));

app.post("/admin/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ success: false, error: "Invalid credentials" });
  }

  const token = `tok_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  adminTokens.add(token);
  res.json({ success: true, token });
});

app.get("/admin/me", auth, (_req, res) => {
  res.json({ success: true });
});

app.post("/admin/logout", auth, (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (token) adminTokens.delete(token);
  res.json({ success: true });
});

app.post("/create", async (req, res) => {
  try {
    const trackingId = "TRK" + Date.now();
    const senderName = String(req.body.senderName || "").trim();
    const receiverName = String(req.body.receiverName || "").trim();
    const pickupText = String(req.body.pickup || "").trim();
    const dropText = String(req.body.drop || "").trim();

    if (!senderName || !receiverName || !pickupText || !dropText) {
      return res.status(400).json({ success: false, error: "Sender name, receiver name, pickup, and drop are required" });
    }

    const pickupPoint = await geocode(pickupText);
    const dropPoint = await geocode(dropText);
    const route = await getRoute(pickupPoint, dropPoint);

    await Shipment.create({
      trackingId,
      senderName,
      receiverName,
      pickupText,
      dropText,
      pickup: pickupPoint,
      drop: dropPoint,
      weight: Number(req.body?.weight || 0),
      truckType: String(req.body?.truckType || "Small Truck"),
      status: "Created",
      location: pickupPoint,
      history: [pickupPoint],
      route,
      routeIndex: 0
    });

    console.log(`📦 Created shipment ${trackingId} from ${pickupText} to ${dropText}`);
    res.json({ success: true, trackingId });
  } catch (err) {
    console.error("Create error:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get("/shipment/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const shipment = await Shipment.findOne({ trackingId: id }).lean();

    if (!shipment) {
      return res.status(404).json({ success: false, error: "Not found" });
    }

    res.json({
      success: true,
      shipment: formatShipment(shipment),
      location: shipment.location
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/start/:id", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const shipment = await Shipment.findOne({ trackingId: id });

    if (!shipment || !Array.isArray(shipment.route) || shipment.route.length === 0) {
      return res.status(404).json({ success: false, error: "Invalid ID" });
    }

    clearShipmentInterval(id);
    shipment.status = "In Transit";
    await shipment.save();

    intervals[id] = setInterval(() => {
      moveShipment(id).catch(err => console.error("Move error:", err.message));
    }, TICK_MS);

    res.json({ success: true, message: "Truck Started" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/stop/:id", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const reason = String(req.body?.reason || req.query?.reason || "Manual").trim();
    clearShipmentInterval(id);

    const shipment = await Shipment.findOne({ trackingId: id });
    if (shipment) {
      shipment.status = "Paused";
      shipment.pauseReason = reason;
      await shipment.save();
    }

    console.log(`⛔ STOP ${id} reason=${reason}`);
    res.json({ success: true, message: "Truck Stopped", reason });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/update-location/:id", auth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: "Invalid latitude/longitude" });
    }

    const shipment = await Shipment.findOne({ trackingId: id });
    if (!shipment) {
      return res.status(404).json({ success: false, error: "Invalid ID" });
    }

    shipment.location = { lat, lng };
    shipment.history.push({ lat, lng });
    await shipment.save();

    res.json({ success: true, message: "Location Updated" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/test", (_req, res) => {
  res.send("Server is working");
});

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});