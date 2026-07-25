// Firebase initialisation
// ---------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBjgL62cUaMJnCcTi4M_gFfOFOkJEqgNh4",
  authDomain: "gpsoni-92e20.firebaseapp.com",
  databaseURL: "https://gpsoni-92e20-default-rtdb.firebaseio.com",
  projectId: "gpsoni-92e20"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---------------------------
// State
// ---------------------------
let map;

// userID はブラウザに保存して固定化する（リロードしても同じ人として扱われるように）
function getOrCreateUserID() {
  let id = localStorage.getItem("gpsoni_userID");
  if (!id) {
    id = "user_" + Math.floor(Math.random() * 99999);
    localStorage.setItem("gpsoni_userID", id);
  }
  return id;
}
let userID = getOrCreateUserID();

// 名前もブラウザに保存する
function getStoredPlayerName() {
  return localStorage.getItem("gpsoni_playerName") || "";
}
function setStoredPlayerName(name) {
  localStorage.setItem("gpsoni_playerName", name);
}
let playerName = getStoredPlayerName();

// ゲーム上の役割（鬼 or にげる）もブラウザに保存する。回によって変わるので後から切り替え可能。
function getStoredGameRole() {
  const r = localStorage.getItem("gpsoni_gameRole");
  return r === "oni" || r === "player" ? r : "";
}
function setStoredGameRole(r) {
  localStorage.setItem("gpsoni_gameRole", r);
}
let gameRole = getStoredGameRole(); // "oni" | "player" | ""（未選択）

// ---------------------------
// 管理者判定：URLの合言葉(?admin=...)が一致した人だけが管理者になる。
// これにより、リンクを共有された一般参加者が管理画面(プレイエリア設定・ゲーム開始・リセット等)に
// 誤って/勝手に入ることはない。合言葉は好きな文字列に変更してOK。
// 管理者用URLの例: index.html?admin=oni-master-2024
// ---------------------------
const ADMIN_ACCESS_KEY = "oni-master-2024";
const isAdmin = new URLSearchParams(window.location.search).get("admin") === ADMIN_ACCESS_KEY;

let playAreaPolygon = null;
let zones = [];
let playerMarkers = {};
let zoneCircles = {};      // id -> Circleインスタンス
let fadingZoneIds = new Set(); // フェードアウト中のzone idを記録（二重実行防止）
let currentPosition = null;
let ownMarker = null;

const CHECKPOINT_RADIUS_METERS = 40; // チェックポイントの大きさは常にこれ

let gameStarted = false;   // ゲームがまだ始まっていない間はチェックポイント判定をしない
let isPlacingZone = false; // チェックポイント設置モード中かどうか
let isDrawingArea = false; // プレイエリア設置モード中かどうか
let drawAreaPoints = [];   // タップして置いた頂点
let drawAreaPreview = null; // 作成中のプレビュー多角形
let locationInterval = null;

// 管理者は名前・役割選択なしで即開始。一般参加者は名前とゲーム上の役割(鬼/にげる)が揃うまで待つ。
let identityReady = isAdmin || (!!playerName && !!gameRole);
let mapReady = false;

// マーカーの色分け（鬼=赤 / にげる=青 / 管理者=グレー）
const ROLE_COLORS = {
  admin: "#757575",
  oni: "#e53935",
  player: "#1e88e5"
};
function colorForRole(r) {
  return ROLE_COLORS[r] || ROLE_COLORS.player;
}
function currentDbRole() {
  return isAdmin ? "admin" : gameRole;
}

// 位置更新の間隔（ミリ秒）。指示により1分=60000。30秒にしたい場合は30000に変更。
const LOCATION_UPDATE_INTERVAL_MS = 60000;

// ---------------------------
// Google Maps initialisation
// ---------------------------
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 35.0, lng: 135.7 },
    zoom: 15
  });

  // 地図タップ/クリック時の処理
  map.addListener("click", (event) => {
    const clickedPosition = {
      lat: event.latLng.lat(),
      lng: event.latLng.lng()
    };

    if (isDrawingArea) {
      addAreaPoint(clickedPosition);
      return;
    }

    if (isPlacingZone) {
      placeCheckpointAt(clickedPosition);
      isPlacingZone = false;
    }
  });

  setupUI();
  setupNameModal();
  setupRoleSwitchControls();
  loadPlayArea();
  loadZones();
  loadPlayers();
  listenGameState();
  startOwnLocationWatch(); // ページを開いた瞬間から常時、自分の位置を追跡

  mapReady = true;
  if (identityReady) {
    beginTracking(); // 既に名前・役割が保存済み（または管理者）なら、位置が取れ次第すぐ共有を始める
  }
}

// ---------------------------
// 名前・役割入力モーダル（一般参加者が最初に開いたときだけ表示。管理者には出さない）
// ---------------------------
function setupNameModal() {
  const modal = document.getElementById("nameModal");
  const input = document.getElementById("nameInput");
  const submitBtn = document.getElementById("nameSubmitBtn");
  const roleButtons = document.querySelectorAll("#nameModal .roleChoiceBtn");
  if (!modal || !input || !submitBtn) return;

  if (isAdmin || identityReady) {
    modal.classList.remove("show");
    return;
  }

  let pendingRole = gameRole || "";
  highlightRoleButtons(roleButtons, pendingRole);

  modal.classList.add("show");
  input.focus();

  roleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingRole = btn.dataset.role;
      highlightRoleButtons(roleButtons, pendingRole);
    });
  });

  const submit = () => {
    const name = input.value.trim();
    if (!name) {
      alert("なまえを入力してください");
      return;
    }
    if (pendingRole !== "oni" && pendingRole !== "player") {
      alert("「鬼」か「にげる」のどちらかを選んでください");
      return;
    }

    playerName = name;
    setStoredPlayerName(name);
    gameRole = pendingRole;
    setStoredGameRole(gameRole);
    identityReady = true;
    modal.classList.remove("show");

    updateRoleDependentUI();

    if (mapReady) {
      beginTracking(); // 名前・役割が確定したら、位置が取れ次第すぐ共有を始める
    }
  };

  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

function highlightRoleButtons(buttons, selectedRole) {
  buttons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.role === selectedRole);
  });
}

// ---------------------------
// あとから役割（鬼/にげる）を切り替えるための常設ボタン（管理者には表示しない）
// ---------------------------
function setupRoleSwitchControls() {
  const panel = document.getElementById("roleSwitchControls");
  if (!panel) return;

  if (isAdmin) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "flex";
  const buttons = panel.querySelectorAll(".roleChoiceBtn");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const newRole = btn.dataset.role;
      if (newRole === gameRole) return;

      gameRole = newRole;
      setStoredGameRole(gameRole);
      highlightRoleButtons(buttons, gameRole);
      updateRoleDependentUI();
      updateOwnMarker();
      writeOwnPlayerState(); // 他の人の画面の色もすぐ更新
    });
  });

  highlightRoleButtons(buttons, gameRole);
}

// 役割(鬼/にげる)に応じて表示する操作パネルを切り替える
function updateRoleDependentUI() {
  const playerControls = document.getElementById("playerControls");
  if (playerControls) {
    playerControls.style.display = (!isAdmin && gameRole === "player") ? "block" : "none";
  }
}

function setupUI() {
  const adminControls = document.getElementById("adminControls");

  if (adminControls) {
    adminControls.style.display = isAdmin ? "block" : "none";
  }

  updateRoleDependentUI();

  document.getElementById("drawAreaBtn")?.addEventListener("click", startDrawPlayArea);
  document.getElementById("finishAreaBtn")?.addEventListener("click", finishDrawPlayArea);
  document.getElementById("cancelAreaBtn")?.addEventListener("click", cancelDrawPlayArea);

  document.getElementById("addZoneBtn")?.addEventListener("click", () => {
    if (isDrawingArea) {
      alert("先にプレイエリアの設置を終えてください（確定 or キャンセル）");
      return;
    }
    isPlacingZone = true;
    alert("チェックポイントを置きたい場所を地図上でクリックしてください");
  });

  document.getElementById("startBtn")?.addEventListener("click", startGame);
  document.getElementById("resetBtn")?.addEventListener("click", resetGame);
  document.getElementById("caughtBtn")?.addEventListener("click", markCaught);
  document.getElementById("freeBtn")?.addEventListener("click", markFree);
}

// ---------------------------
// プレイエリア（多角形）: 地図をタップして頂点を置き、「エリア確定」ボタンで確定する
// ---------------------------
function startDrawPlayArea() {
  if (!isAdmin || !map) return;

  isDrawingArea = true;
  isPlacingZone = false; // 同時に他のモードに入らないようにする
  drawAreaPoints = [];

  if (drawAreaPreview) {
    drawAreaPreview.setMap(null);
    drawAreaPreview = null;
  }

  document.getElementById("drawAreaBtn").style.display = "none";
  document.getElementById("finishAreaBtn").style.display = "inline-block";
  document.getElementById("cancelAreaBtn").style.display = "inline-block";

  alert("地図をタップしてプレイエリアの頂点を置いてください（3点以上）。置き終わったら「エリア確定」を押してください。");
}

function addAreaPoint(position) {
  drawAreaPoints.push(position);

  if (drawAreaPreview) {
    drawAreaPreview.setMap(null);
  }

  // 1〜2点の間は線として、3点以上になったら面として見えるようにプレビュー表示
  drawAreaPreview = new google.maps.Polygon({
    paths: drawAreaPoints,
    fillColor: "#4caf50",
    fillOpacity: drawAreaPoints.length >= 3 ? 0.25 : 0,
    strokeColor: "#2e7d32",
    strokeWeight: 2,
    map
  });
}

function finishDrawPlayArea() {
  if (!isAdmin) return;

  if (drawAreaPoints.length < 3) {
    alert("プレイエリアには3点以上必要です。地図をタップして頂点を追加してください。");
    return;
  }

  if (playAreaPolygon) {
    playAreaPolygon.setMap(null);
  }

  playAreaPolygon = drawAreaPreview;
  savePlayArea(playAreaPolygon);

  drawAreaPreview = null;
  isDrawingArea = false;
  drawAreaPoints = [];

  document.getElementById("drawAreaBtn").style.display = "inline-block";
  document.getElementById("finishAreaBtn").style.display = "none";
  document.getElementById("cancelAreaBtn").style.display = "none";
}

function cancelDrawPlayArea() {
  if (drawAreaPreview) {
    drawAreaPreview.setMap(null);
    drawAreaPreview = null;
  }

  isDrawingArea = false;
  drawAreaPoints = [];

  document.getElementById("drawAreaBtn").style.display = "inline-block";
  document.getElementById("finishAreaBtn").style.display = "none";
  document.getElementById("cancelAreaBtn").style.display = "none";
}

function savePlayArea(polygon) {
  db.ref("playArea").set({
    path: polygon.getPath().getArray().map((latLng) => ({
      lat: latLng.lat(),
      lng: latLng.lng()
    }))
  });
}

function loadPlayArea() {
  db.ref("playArea").on("value", (snapshot) => {
    const data = snapshot.val();

    // 既存のプレイエリアはいったん消す（リセットされた場合もここで消える）
    if (playAreaPolygon) {
      playAreaPolygon.setMap(null);
      playAreaPolygon = null;
    }

    if (!data || !Array.isArray(data.path) || data.path.length < 3) {
      return;
    }

    playAreaPolygon = new google.maps.Polygon({
      paths: data.path,
      fillColor: "#4caf50",
      fillOpacity: 0.2,
      strokeColor: "#2e7d32",
      strokeWeight: 2,
      map
    });
  });
}

// ---------------------------
// チェックポイント（クリックで即設置・大きさは常に40／通過したらフェードアウトして消える）
// ---------------------------
function placeCheckpointAt(position) {
  if (!isAdmin) return;

  db.ref("zones").push({
    position,
    radius: CHECKPOINT_RADIUS_METERS,
    createdAt: Date.now()
  });
}

function renderZoneCircle(zone) {
  if (!zone.position || zoneCircles[zone.id]) return;

  const circle = new google.maps.Circle({
    center: zone.position,
    radius: zone.radius || CHECKPOINT_RADIUS_METERS,
    map,
    fillColor: "#2196f3",
    fillOpacity: 0.25,
    strokeColor: "#1565c0",
    strokeOpacity: 1,
    strokeWeight: 2,
    clickable: true
  });

  // 管理者はダブルクリック/ダブルタップでチェックポイントを削除できる
  if (isAdmin) {
    circle.addListener("dblclick", () => {
      if (confirm("このチェックポイントを削除しますか？")) {
        db.ref(`zones/${zone.id}`).remove();
      }
    });
  }

  zoneCircles[zone.id] = circle;
}

// 通過済みになった円を、じわっと薄くしてから地図上・データ上の両方から消す
function fadeOutZone(zoneId) {
  const circle = zoneCircles[zoneId];
  if (!circle) return;

  const durationMs = 800;
  const stepMs = 30;
  const totalSteps = durationMs / stepMs;
  let step = 0;

  const timer = setInterval(() => {
    step++;
    const ratio = Math.max(1 - step / totalSteps, 0);

    circle.setOptions({
      fillOpacity: 0.25 * ratio,
      strokeOpacity: 1 * ratio
    });

    if (step >= totalSteps) {
      clearInterval(timer);
      circle.setMap(null);
      delete zoneCircles[zoneId];
      fadingZoneIds.delete(zoneId);
      db.ref(`zones/${zoneId}`).remove();
    }
  }, stepMs);
}

function loadZones() {
  db.ref("zones").on("child_added", (snapshot) => {
    const zone = { id: snapshot.key, ...snapshot.val() };
    zones.push(zone);
    renderZoneCircle(zone);
  });

  db.ref("zones").on("child_changed", (snapshot) => {
    const zone = { id: snapshot.key, ...snapshot.val() };
    const index = zones.findIndex((z) => z.id === zone.id);
    if (index >= 0) zones[index] = zone;

    if (zone.passed && !fadingZoneIds.has(zone.id)) {
      fadingZoneIds.add(zone.id);
      fadeOutZone(zone.id);
    }
  });

  db.ref("zones").on("child_removed", (snapshot) => {
    const id = snapshot.key;
    zones = zones.filter((z) => z.id !== id);

    if (zoneCircles[id]) {
      zoneCircles[id].setMap(null);
      delete zoneCircles[id];
    }
    fadingZoneIds.delete(id);
  });
}

// にげる側(gameRole === "player")が半径内に入ったら「通過済み」フラグを立てる→全員の画面でフェードアウトする
function checkZonePassing() {
  if (!currentPosition || isAdmin || gameRole !== "player") return;

  zones.forEach((zone) => {
    if (!zone.position || zone.passed) return;

    const distance = google.maps.geometry.spherical.computeDistanceBetween(
      new google.maps.LatLng(currentPosition.lat, currentPosition.lng),
      new google.maps.LatLng(zone.position.lat, zone.position.lng)
    );

    if (distance <= (zone.radius || CHECKPOINT_RADIUS_METERS)) {
      db.ref(`zones/${zone.id}`).update({ passed: true, passedAt: Date.now() });
    }
  });
}

// ---------------------------
// 他プレイヤーの表示
// ---------------------------
function loadPlayers() {
  db.ref("players").on("value", (snapshot) => {
    const players = snapshot.val() || {};

    Object.entries(playerMarkers).forEach(([id, marker]) => {
      if (!players[id]) {
        marker.setMap(null);
        delete playerMarkers[id];
      }
    });

    Object.entries(players).forEach(([id, player]) => {
      if (!player.position || id === userID) return;

      const displayName = player.name || (player.role === "admin" ? "管理者" : id);

      const markerOptions = {
        position: player.position,
        map,
        title: `${displayName} (${player.status || "active"})`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: colorForRole(player.role),
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2
        }
      };

      if (playerMarkers[id]) {
        playerMarkers[id].setPosition(player.position);
        playerMarkers[id].setTitle(markerOptions.title);
        playerMarkers[id].setIcon(markerOptions.icon);
      } else {
        playerMarkers[id] = new google.maps.Marker(markerOptions);
      }
    });
  });
}

// ---------------------------
// 自分の現在地
// ---------------------------
function updateOwnMarker() {
  if (!currentPosition || !map) return;

  const fillColor = colorForRole(currentDbRole());

  if (ownMarker) {
    ownMarker.setPosition(currentPosition);
    ownMarker.setIcon({
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2
    });
  } else {
    ownMarker = new google.maps.Marker({
      position: currentPosition,
      map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2
      },
      title: "自分の現在地"
    });
  }
}

let hasCenteredMap = false; // 最初の1回だけ地図を自分の場所に合わせるためのフラグ

// ページを開いた瞬間から常に(GPSが動くたびに)自分の位置を取得・表示する
function startOwnLocationWatch() {
  if (!navigator.geolocation) {
    console.warn("Geolocation is not available in this browser.");
    return;
  }

  navigator.geolocation.watchPosition(
    (position) => {
      currentPosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };

      if (map && !hasCenteredMap) {
        map.setCenter(currentPosition);
        hasCenteredMap = true;
      }

      updateOwnMarker(); // 自分の表示は常に即座に更新

      if (identityReady && locationInterval) {
        writeOwnPlayerState(); // 位置が動くたびに、他の人への共有も即座に更新
      }

      if (gameStarted) {
        checkZonePassing(); // ゲーム開始後だけチェックポイント通過を判定
      }
    },
    handleLocationError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

// 名前・役割が確定し、地図の準備ができ次第呼ばれる。
// 他のプレイヤーへの位置共有(Firebaseへの書き込み)を指定間隔(既定1分)ごとに始める。
// ※ゲーム開始を待たず、サイトを開いた時点から常に共有する。
function beginTracking() {
  if (locationInterval) return; // 二重起動防止
  if (!identityReady) return; // 名前・役割未確定なら開始しない

  writeOwnPlayerState();
  locationInterval = setInterval(() => {
    writeOwnPlayerState();
  }, LOCATION_UPDATE_INTERVAL_MS);
}

function writeOwnPlayerState(extraState = {}) {
  if (!currentPosition || !identityReady) return;

  db.ref(`players/${userID}`).set({
    userID,
    name: isAdmin ? (playerName || "管理者") : playerName,
    role: currentDbRole(), // "admin" | "oni" | "player"
    position: currentPosition,
    status: "active",
    updatedAt: Date.now(),
    ...extraState
  });
}

function handleLocationError(error) {
  console.warn("Failed to get location.", error);
  alert("位置情報を取得できませんでした。位置情報の許可をONにしてください。");
}

// ---------------------------
// ゲーム開始の合図
// ---------------------------
const GAME_DURATION_MS = 2 * 60 * 60 * 1000; // 所要時間: 2時間
let countdownInterval = null;

function startGame() {
  if (!isAdmin) return;

  db.ref("game/state").set({
    started: true,
    startedAt: Date.now(),
    durationMs: GAME_DURATION_MS,
    updatedBy: userID
  });
}

// プレイエリア・チェックポイント・参加者の状態をリセット（管理者のみ）
function resetGame() {
  if (!isAdmin) return;

  if (!confirm("プレイエリア・チェックポイント・参加者の状態をすべてリセットします。よろしいですか？")) {
    return;
  }

  db.ref("playArea").remove();
  db.ref("zones").remove();
  db.ref("players").remove();
}

function listenGameState() {
  db.ref("game/state").on("value", (snapshot) => {
    const state = snapshot.val();
    if (state && state.started) {
      if (!gameStarted) {
        gameStarted = true;
        beginTracking();
      }
      startCountdown(state.startedAt, state.durationMs || GAME_DURATION_MS);
    }
  });
}

// ---------------------------
// カウントダウン表示
// ---------------------------
function ensureCountdownBanner() {
  if (document.getElementById("gameStartedBanner")) return;

  const banner = document.createElement("div");
  banner.id = "gameStartedBanner";
  Object.assign(banner.style, {
    position: "absolute",
    top: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#ff5722",
    color: "#fff",
    padding: "12px 24px",
    borderRadius: "8px",
    fontSize: "18px",
    zIndex: "9999",
    textAlign: "center"
  });
  document.body.appendChild(banner);
}

function startCountdown(startedAt, durationMs) {
  const endTime = startedAt + durationMs;

  ensureCountdownBanner();

  if (countdownInterval) {
    clearInterval(countdownInterval);
  }

  updateCountdownDisplay(endTime);
  countdownInterval = setInterval(() => updateCountdownDisplay(endTime), 1000);
}

function updateCountdownDisplay(endTime) {
  const banner = document.getElementById("gameStartedBanner");
  if (!banner) return;

  const remainingMs = endTime - Date.now();

  if (remainingMs <= 0) {
    banner.textContent = "ゲーム終了！";
    clearInterval(countdownInterval);
    countdownInterval = null;
    return;
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");

  banner.textContent = `残り時間 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function markCaught() {
  if (isAdmin || gameRole !== "player") return;
  writeOwnPlayerState({ status: "caught", caughtAt: Date.now() });
}

function markFree() {
  if (isAdmin || gameRole !== "player") return;
  writeOwnPlayerState({ status: "active", caughtAt: null, freedAt: Date.now() });
}

window.initMap = initMap;
