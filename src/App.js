import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const MET = { Running: 8.5, Cycling: 6.0 };
const GOAL_DEFAULTS = { Running: 5000, Cycling: 20000 }; // meters

// ─── Haversine distance ───────────────────────────────────────────────────────
function haversine(a, b) {
  const R = 6371000;
  const φ1 = (a.lat * Math.PI) / 180, φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function formatTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}
function formatDist(m) { return m >= 1000 ? `${(m/1000).toFixed(2)} km` : `${Math.round(m)} m`; }
function formatPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return "--:--";
  const m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2,"0")} /km`;
}

// ─── Mini Map Component (Canvas) ─────────────────────────────────────────────
function RouteCanvas({ coords, width = 300, height = 180, accent = "#00f5a0" }) {
  const canvasRef = useRef();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || coords.length < 2) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const lats = coords.map(c => c.lat), lngs = coords.map(c => c.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const pad = 16;
    const scaleX = (W - pad*2) / (maxLng - minLng || 1);
    const scaleY = (H - pad*2) / (maxLat - minLat || 1);
    const toX = lng => pad + (lng - minLng) * scaleX;
    const toY = lat => H - pad - (lat - minLat) * scaleY;
    // Draw glow
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    coords.forEach((c, i) => i === 0 ? ctx.moveTo(toX(c.lng), toY(c.lat)) : ctx.lineTo(toX(c.lng), toY(c.lat)));
    ctx.stroke();
    // Start dot
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(toX(coords[0].lng), toY(coords[0].lat), 4, 0, Math.PI*2); ctx.fill();
    // End dot
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(toX(coords[coords.length-1].lng), toY(coords[coords.length-1].lat), 5, 0, Math.PI*2); ctx.fill();
  }, [coords, accent]);
  return <canvas ref={canvasRef} width={width} height={height} style={{ width: "100%", height: "100%", borderRadius: 12 }} />;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function FitTrack() {
  // ── Storage helpers ────────────────────────────────────────────────────────
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  // ── State ──────────────────────────────────────────────────────────────────
  const [screen, setScreen] = useState(() => load("ft_user", null) ? "home" : "login");
  const [user, setUser] = useState(() => load("ft_user", { name: "", weight: 70 }));
  const [darkMode, setDarkMode] = useState(() => load("ft_dark", true));
  const [activity, setActivity] = useState("Running");
  const [trackState, setTrackState] = useState("idle"); // idle | running | paused | stopped
  const [elapsed, setElapsed] = useState(0);
  const [distance, setDistance] = useState(0);
  const [coords, setCoords] = useState([]);
  const [, setSpeed] = useState(0);
  const [history, setHistory] = useState(() => load("ft_history", []));
  const [goals, setGoals] = useState(() => load("ft_goals", GOAL_DEFAULTS));
  const [loginName, setLoginName] = useState("");
  const [loginWeight, setLoginWeight] = useState("70");
  const [settingsWeight, setSettingsWeight] = useState(() => String(load("ft_user", { weight: 70 }).weight));
  const [settingsGoalRun, setSettingsGoalRun] = useState(() => String(load("ft_goals", GOAL_DEFAULTS).Running / 1000));
  const [settingsGoalCyc, setSettingsGoalCyc] = useState(() => String(load("ft_goals", GOAL_DEFAULTS).Cycling / 1000));
  const [notification, setNotification] = useState(null);
  const [activeHistItem, setActiveHistItem] = useState(null);
  const [isAutoPaused, setIsAutoPaused] = useState(false);

  const timerRef = useRef(null);
  const watchRef = useRef(null);
  const startTimeRef = useRef(null);
  const pausedElapsedRef = useRef(0);
  const lastCoordRef = useRef(null);
  const zeroSpeedSinceRef = useRef(null);   // timestamp jab speed 0 hua
  const autoPausedRef = useRef(false);       // auto-pause active hai ya nahi
  const trackStateRef = useRef("idle");      // latest trackState for GPS callback
  const AUTO_PAUSE_DELAY = 3000;             // 3 seconds zero speed → auto pause

  // ── Theme ──────────────────────────────────────────────────────────────────
  const theme = darkMode ? {
    bg: "#0a0c10", card: "#12161e", border: "#1e2535", text: "#e8eaf0",
    muted: "#6b7591", accent: "#00f5a0", accentAlt: "#0af", danger: "#ff4757",
    warn: "#ffa502", surface: "#1a1f2e"
  } : {
    bg: "#f0f4ff", card: "#ffffff", border: "#dde3f5", text: "#1a1f3c",
    muted: "#8891b0", accent: "#00c47a", accentAlt: "#007aff", danger: "#ff3b30",
    warn: "#ff9500", surface: "#e8edf8"
  };

  // ── Notification helper ────────────────────────────────────────────────────
  const notify = useCallback((msg, type = "info") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  // ── Login ──────────────────────────────────────────────────────────────────
  const handleLogin = () => {
    if (!loginName.trim()) { notify("Naam toh daalo bhai! 😅", "warn"); return; }
    const u = { name: loginName.trim(), weight: parseFloat(loginWeight) || 70 };
    setUser(u); save("ft_user", u);
    setScreen("home");
  };

  // ── Tracking ───────────────────────────────────────────────────────────────

  // Internal helpers that don't need React state for timer
  const _doAutoPause = useCallback((currentElapsed) => {
    clearInterval(timerRef.current);
    pausedElapsedRef.current = currentElapsed;
    autoPausedRef.current = true;
    trackStateRef.current = "paused";
    setIsAutoPaused(true);
    setTrackState("paused");
    notify("Auto-paused ⏸️ (speed = 0)", "warn");
  }, [notify]);

  const _doAutoResume = useCallback(() => {
    autoPausedRef.current = false;
    zeroSpeedSinceRef.current = null;
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() =>
      setElapsed(pausedElapsedRef.current + Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    trackStateRef.current = "running";
    setIsAutoPaused(false);
    setTrackState("running");
    notify("Auto-resumed 🏃‍♂️", "success");
  }, [notify]);

  // Shared GPS callback factory — used by both start & manual resume
  const makeGpsCallback = useCallback(() => (pos) => {
    const spd = pos.coords.speed || 0;
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    setSpeed(spd);
    lastCoordRef.current = p;

    // ── Auto-pause / auto-resume logic ──────────────────────────────────────
    if (trackStateRef.current === "running") {
      if (spd < 0.3) {                                     // ~1 km/h threshold
        if (!zeroSpeedSinceRef.current) zeroSpeedSinceRef.current = Date.now();
        else if (Date.now() - zeroSpeedSinceRef.current >= AUTO_PAUSE_DELAY) {
          setElapsed(prev => { _doAutoPause(prev); return prev; }); // capture latest elapsed
        }
      } else {
        zeroSpeedSinceRef.current = null;                  // moving → reset counter
      }
    } else if (trackStateRef.current === "paused" && autoPausedRef.current) {
      if (spd >= 0.3) _doAutoResume();                     // moving again → auto-resume
    }
    // ────────────────────────────────────────────────────────────────────────

    // Only add coords + distance if actively running
    if (trackStateRef.current === "running") {
      setCoords(prev => {
        if (prev.length > 0) {
          const d = haversine(prev[prev.length - 1], p);
          setDistance(dist => dist + d);
        }
        return [...prev, p];
      });
    }
  }, [_doAutoPause, _doAutoResume]);

  const startTracking = () => {
    if (!navigator.geolocation) { notify("GPS not available 😔", "error"); return; }
    trackStateRef.current = "running";
    autoPausedRef.current = false;
    zeroSpeedSinceRef.current = null;
    setIsAutoPaused(false);
    setTrackState("running");
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() =>
      setElapsed(pausedElapsedRef.current + Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    watchRef.current = navigator.geolocation.watchPosition(
      makeGpsCallback(),
      err => notify("GPS error: " + err.message, "error"),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
    notify(`${activity} shuru! 🏃‍♂️`, "success");
  };

  const pauseTracking = () => {
    clearInterval(timerRef.current);
    navigator.geolocation.clearWatch(watchRef.current);
    pausedElapsedRef.current = elapsed;
    autoPausedRef.current = false;
    zeroSpeedSinceRef.current = null;
    trackStateRef.current = "paused";
    setIsAutoPaused(false);
    setTrackState("paused");
    notify("Paused ⏸️", "warn");
  };

  const resumeTracking = () => {
    autoPausedRef.current = false;
    zeroSpeedSinceRef.current = null;
    startTimeRef.current = Date.now();
    trackStateRef.current = "running";
    setIsAutoPaused(false);
    timerRef.current = setInterval(() =>
      setElapsed(pausedElapsedRef.current + Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    watchRef.current = navigator.geolocation.watchPosition(
      makeGpsCallback(),
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
    setTrackState("running");
    notify("Resume! 🏃‍♂️", "success");
  };

  const stopTracking = () => {
    clearInterval(timerRef.current);
    navigator.geolocation.clearWatch(watchRef.current);
    const cal = ((MET[activity] * user.weight * elapsed) / 3600).toFixed(0);
    const rec = {
      id: Date.now(), activity, date: new Date().toLocaleDateString("en-IN"),
      time: elapsed, distance, speed: distance > 0 && elapsed > 0 ? (distance / elapsed) : 0,
      calories: parseInt(cal), coords,
      pace: activity === "Running" && distance > 0 ? elapsed / (distance / 1000) : null
    };
    const newHist = [rec, ...history];
    setHistory(newHist); save("ft_history", newHist);
    // Check goal
    const todayDist = newHist.filter(r => r.date === rec.date && r.activity === activity).reduce((s, r) => s + r.distance, 0);
    if (todayDist >= goals[activity]) notify(`🎯 Daily ${activity} goal reached! 🔥`, "success");
    else notify(`Saved! ${formatDist(distance)} ${activity} complete 💪`, "success");
    // Reset
    setTrackState("idle"); setElapsed(0); setDistance(0); setCoords([]); setSpeed(0);
    pausedElapsedRef.current = 0;
    setScreen("home");
  };

  useEffect(() => () => { clearInterval(timerRef.current); if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current); }, []);

  // ── Computed ───────────────────────────────────────────────────────────────
  const calories = ((MET[activity] * user.weight * elapsed) / 3600).toFixed(0);
  const avgSpeed = elapsed > 0 ? (distance / elapsed) * 3.6 : 0; // km/h
  const pace = activity === "Running" && distance > 0 ? elapsed / (distance / 1000) : null;
  const today = new Date().toLocaleDateString("en-IN");
  const todayDist = history.filter(r => r.date === today && r.activity === activity).reduce((s, r) => s + r.distance, 0) + distance;
  const goalPct = Math.min(100, (todayDist / goals[activity]) * 100);

  // ── Save settings ──────────────────────────────────────────────────────────
  const saveSettings = () => {
    const u = { ...user, weight: parseFloat(settingsWeight) || user.weight };
    const g = { Running: (parseFloat(settingsGoalRun) || 5) * 1000, Cycling: (parseFloat(settingsGoalCyc) || 20) * 1000 };
    setUser(u); setGoals(g); save("ft_user", u); save("ft_goals", g);
    notify("Settings saved ✅", "success");
    setScreen("home");
  };

  // ── CSS vars injection ─────────────────────────────────────────────────────
  const globalStyle = `
    @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body { font-family: 'Rajdhani', sans-serif; background: ${theme.bg}; color: ${theme.text}; min-height: 100vh; }
    ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: ${theme.bg}; } ::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 4px; }
    input { outline: none; font-family: 'Rajdhani', sans-serif; }
    button { cursor: pointer; font-family: 'Rajdhani', sans-serif; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    @keyframes slideDown { from{transform:translateY(-20px);opacity:0} to{transform:translateY(0);opacity:1} }
    @keyframes fadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
    @keyframes glow { 0%,100%{box-shadow:0 0 8px ${theme.accent}40} 50%{box-shadow:0 0 20px ${theme.accent}80} }
  `;

  const s = {
    wrap: { minHeight: "100vh", background: theme.bg, color: theme.text, paddingBottom: 80 },
    card: { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 16, padding: "18px 20px", marginBottom: 14 },
    btn: (col, outline) => ({
      background: outline ? "transparent" : col, color: outline ? col : (col === theme.accent ? "#000" : "#fff"),
      border: `2px solid ${col}`, borderRadius: 12, padding: "12px 24px", fontSize: 16, fontWeight: 700,
      fontFamily: "'Rajdhani', sans-serif", letterSpacing: 1, transition: "all .2s", cursor: "pointer"
    }),
    input: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, padding: "12px 16px", color: theme.text, fontSize: 16, width: "100%", fontFamily: "'Rajdhani', sans-serif" },
    nav: { position: "fixed", bottom: 0, left: 0, right: 0, background: theme.card, borderTop: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-around", padding: "8px 0 12px", zIndex: 100 },
    navBtn: (active) => ({ background: "none", border: "none", color: active ? theme.accent : theme.muted, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: "4px 12px" }),
    stat: { textAlign: "center", flex: 1 },
    statVal: { fontSize: 28, fontWeight: 700, fontFamily: "'Space Mono', monospace", color: theme.accent },
    statLbl: { fontSize: 11, color: theme.muted, letterSpacing: 1, textTransform: "uppercase", marginTop: 2 },
    header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 8px" },
  };

  // ─── Screens ───────────────────────────────────────────────────────────────

  // LOGIN
  if (screen === "login") return (
    <>
      <style>{globalStyle}</style>
      <div style={{ minHeight: "100vh", background: theme.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 360, animation: "fadeIn .4s ease" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ fontSize: 52, marginBottom: 8 }}>⚡</div>
            <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: 2, color: theme.accent }}>FITTRACK</div>
            <div style={{ color: theme.muted, fontSize: 14, letterSpacing: 2 }}>YOUR PERSONAL TRAINER</div>
          </div>
          <div style={s.card}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: theme.muted, letterSpacing: 1, marginBottom: 6 }}>YOUR NAME</div>
              <input style={s.input} placeholder="e.g. Yuvraj" value={loginName} onChange={e => setLoginName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: theme.muted, letterSpacing: 1, marginBottom: 6 }}>WEIGHT (kg)</div>
              <input style={s.input} type="number" placeholder="70" value={loginWeight} onChange={e => setLoginWeight(e.target.value)} />
            </div>
            <button style={{ ...s.btn(theme.accent), width: "100%", fontSize: 18 }} onClick={handleLogin}>LET'S GO 🚀</button>
          </div>
        </div>
      </div>
    </>
  );

  // ACTIVITY SCREEN (tracker)
  const TrackerScreen = () => (
    <div style={{ padding: "0 16px", animation: "fadeIn .3s ease" }}>
      {/* Activity toggle */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        {["Running", "Cycling"].map(a => (
          <button key={a} disabled={trackState !== "idle"} onClick={() => setActivity(a)}
            style={{ ...s.btn(a === activity ? theme.accent : theme.surface, a !== activity), flex: 1, fontSize: 15, opacity: trackState !== "idle" && a !== activity ? .4 : 1 }}>
            {a === "Running" ? "🏃 Running" : "🚴 Cycling"}
          </button>
        ))}
      </div>

      {/* Stats grid */}
      <div style={{ ...s.card, animation: trackState === "running" ? "glow 2s infinite" : "none" }}>
        <div style={{ display: "flex", marginBottom: 16, borderBottom: `1px solid ${theme.border}`, paddingBottom: 16 }}>
          <div style={s.stat}><div style={s.statVal}>{formatTime(elapsed)}</div><div style={s.statLbl}>TIME</div></div>
          <div style={{ width: 1, background: theme.border }} />
          <div style={s.stat}><div style={s.statVal}>{(distance / 1000).toFixed(2)}</div><div style={s.statLbl}>KM</div></div>
        </div>
        <div style={{ display: "flex" }}>
          <div style={s.stat}><div style={{ ...s.statVal, fontSize: 22 }}>{avgSpeed.toFixed(1)}</div><div style={s.statLbl}>KM/H</div></div>
          <div style={{ width: 1, background: theme.border }} />
          {activity === "Running"
            ? <div style={s.stat}><div style={{ ...s.statVal, fontSize: 22 }}>{formatPace(pace)}</div><div style={s.statLbl}>PACE</div></div>
            : <div style={s.stat}><div style={{ ...s.statVal, fontSize: 22, color: theme.warn }}>{calories}</div><div style={s.statLbl}>KCAL</div></div>
          }
          <div style={{ width: 1, background: theme.border }} />
          <div style={s.stat}><div style={{ ...s.statVal, fontSize: 22, color: theme.warn }}>{calories}</div><div style={s.statLbl}>KCAL</div></div>
        </div>
      </div>

      {/* Route canvas */}
      <div style={{ ...s.card, height: 180, padding: 8, position: "relative" }}>
        {coords.length < 2
          ? <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: theme.muted, fontSize: 13, flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 32 }}>🗺️</div>
              <div>Route yahan dikhega jab track hoga</div>
            </div>
          : <RouteCanvas coords={coords} accent={theme.accent} />
        }
        {trackState === "running" && <div style={{ position: "absolute", top: 14, right: 14, background: theme.danger, color: "#fff", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWei
