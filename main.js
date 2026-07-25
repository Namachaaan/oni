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

// 管理者かどうかは URL に ?admin=1 が付いていて、かつ正しいパスワードを入力したときだけ true。
// 何も付けない通常のURL（index.html）を開いた人は、全員「参加者」になる。
// 例: index.html          → 参加者用（そのまま配る用のURL）
//     index.html?admin=1  → 管理者(進行役)用。人には配らない。パスワードを求められる。
const ADMIN_PASSWORD = "Ikiruisbest";

function determineIsAdmin() {
  const wantsAdmin = new URLSearchParams(window.location.search).get("admin") === "1";
  if (!wantsAdmin) return false;

  const inputPassword = window.prompt("管理者パスワードを入力してください");
  if (inputPassword === ADMIN_PASSWORD) {
    return true;
  }

  alert("パスワードが違います。参加者として開きます。");
  return false;
}

const isAdmin = determineIsAdmin();

// 参加者本人の役割（鬼/にげる）は自分では選べず、管理者が参加者一覧から割り振る。
// db上のフィールド名は job。'oni' = 鬼(赤) / 'nige' = にげる(青)。
let myJob = null;

let playAreaPolygon = null;
let zones = [];
let playerMarkers = {};
let zoneCircles = {};      // id -> Circleインスタンス
let fadingZoneIds = new Set(); // フェードアウト中のzone idを記録（二重実行防止）
let currentPosition = null;
let ownMarker = null;

const CHECKPOINT_RADIUS_METERS = 40; // チェックポイントの見た目の大きさは常にこれ
const CHECKPOINT_CONTACT_RADIUS_METERS = 8; // 実際に「接触した」と判定して消す距離（見た目の円より小さい）

let gameStarted = false;   // ゲームがまだ始まっていない間はチェックポイント判定をしない
let isPlacingZone = false; // チェックポイント設置モード中かどうか
let isDrawingArea = false; // プレイエリア設置モード中かどうか
let drawAreaPoints = [];   // タップして置いた頂点
let drawAreaPreview = null; // 作成中のプレビュー多角形
let locationInterval = null;
let hasSentInitialPlayerState = false; // job の初期値を書き込むのは最初の1回だけにするためのフラグ

let identityReady = !!playerName; // 名前が既に保存済みなら true
let mapReady = false;

// 位置更新の間隔（ミリ秒）。指示により1分=60000。30秒にしたい場合は30000に変更。
const LOCATION_UPDATE_INTERVAL_MS = 60000;

// 捕まった=黄色 / 鬼=赤 / にげる=青 / 管理者(操作端末)=グレー / 未割り当て=グレー
// ※捕まった状態は job(鬼/にげる)より優先して黄色にする
function colorForPlayer(job, adminFlag, status) {
  if (adminFlag) return "#757575";
  if (status === "caught") return "#fbc02d";
  if (job === "oni") return "#e53935";
  if (job === "nige") return "#1e88e5";
  return "#9e9e9e";
}

// マーカーの上に名前を表示する（スマホではホバーで名前が見えないため、一目で誰か分かるように）
function labelForName(name) {
  return {
    text: name || "?",
    color: "#000000",
    fontSize: "10px",
    fontWeight: "bold"
  };
}

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
  loadPlayArea();
  loadZones();
  loadPlayers();
  listenGameState();
  startOwnLocationWatch(); // ページを開いた瞬間から常時、自分の位置を追跡

  mapReady = true;
  if (identityReady) {
    beginTracking(); // 既に名前が保存済みなら、位置が取れ次第すぐ共有を始める
  }
}

// ---------------------------
// 名前入力モーダル（役割はここでは選ばせない。管理者が後で割り振る）
// ---------------------------
function setupNameModal() {
  const modal = document.getElementById("nameModal");
  const input = document.getElementById("nameInput");
  const submitBtn = document.getElementById("nameSubmitBtn");
  if (!modal || !input || !submitBtn) return;

  // 管理者は名前入力不要（参加者一覧には出てこない操作用アカウントのため）
  if (isAdmin) {
    identityReady = true;
    modal.classList.remove("show");
    return;
  }

  if (identityReady) {
    modal.classList.remove("show");
    return;
  }

  modal.classList.add("show");
  input.focus();

  const submit = () => {
    const name = input.value.trim();
    if (!name) {
      alert("なまえを入力してください");
      return;
    }
    playerName = name;
    setStoredPlayerName(name);
    identityReady = true;
    modal.classList.remove("show");

    if (mapReady) {
      beginTracking(); // 名前が確定したら、位置が取れ次第すぐ共有を始める
    }
  };

  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// 鬼役には「捕まった/復活」ボタンを表示しない（捕まるのはにげる役だけのため）。管理者にも表示しない。
function updatePlayerControlsVisibility() {
  const playerControls = document.getElementById("playerControls");
  if (!playerControls) return;

  if (isAdmin) {
    playerControls.style.display = "none";
    return;
  }

  playerControls.style.display = myJob === "oni" ? "none" : "block";
}

function setupUI() {
  const adminControls = document.getElementById("adminControls");
  const playerControls = document.getElementById("playerControls");
  const participantPanel = document.getElementById("participantPanel");

  if (adminControls) {
    adminControls.style.display = isAdmin ? "block" : "none";
  }

  if (playerControls) {
    updatePlayerControlsVisibility();
  }

  if (participantPanel) {
    participantPanel.classList.toggle("show", isAdmin);
  }

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
  if (!map) return;

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

// にげる役の人がチェックポイントに接触したら「通過済み」フラグを立てる→全員の画面でフェードアウトする
function checkZonePassing() {
  if (!currentPosition || isAdmin || myJob !== "nige") return;

  zones.forEach((zone) => {
    if (!zone.position || zone.passed) return;

    const distance = google.maps.geometry.spherical.computeDistanceBetween(
      new google.maps.LatLng(currentPosition.lat, currentPosition.lng),
      new google.maps.LatLng(zone.position.lat, zone.position.lng)
    );

    if (distance <= CHECKPOINT_CONTACT_RADIUS_METERS) {
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

      const displayName = player.name || id;
      const statusSuffix = player.status === "caught" ? "（捕）" : "";

      const markerOptions = {
        position: player.position,
        map,
        title: `${displayName}${statusSuffix}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 13,
          fillColor: colorForPlayer(player.job, player.isAdmin, player.status),
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2
        },
        label: labelForName(displayName)
      };

      if (playerMarkers[id]) {
        playerMarkers[id].setPosition(player.position);
        playerMarkers[id].setTitle(markerOptions.title);
        playerMarkers[id].setIcon(markerOptions.icon);
        playerMarkers[id].setLabel(markerOptions.label);
      } else {
        playerMarkers[id] = new google.maps.Marker(markerOptions);
      }
    });

    if (isAdmin) {
      renderParticipantList(players);
    }
  });
}

// 管理者用: 参加者一覧を表示し、鬼/にげる をワンタップで割り振れるようにする
function renderParticipantList(players) {
  const container = document.getElementById("participantList");
  if (!container) return;

  const participants = Object.entries(players).filter(([, p]) => !p.isAdmin);

  if (participants.length === 0) {
    container.innerHTML = `<p class="participantEmpty">まだ参加者がいません</p>`;
    return;
  }

  container.innerHTML = "";

  participants.forEach(([id, p]) => {
    const row = document.createElement("div");
    row.className = "participantRow";

    const nameEl = document.createElement("span");
    nameEl.className = "participantName";
    nameEl.textContent = `${p.name || id}${p.status === "caught" ? "（捕）" : ""}`;

    const oniBtn = document.createElement("button");
    oniBtn.type = "button";
    oniBtn.textContent = "鬼";
    oniBtn.className = "jobBtn" + (p.job === "oni" ? " jobOniActive" : "");
    oniBtn.addEventListener("click", () => {
      db.ref(`players/${id}`).update({ job: "oni" });
    });

    const nigeBtn = document.createElement("button");
    nigeBtn.type = "button";
    nigeBtn.textContent = "にげる";
    nigeBtn.className = "jobBtn" + (p.job === "nige" ? " jobNigeActive" : "");
    nigeBtn.addEventListener("click", () => {
      db.ref(`players/${id}`).update({ job: "nige" });
    });

    row.appendChild(nameEl);
    row.appendChild(oniBtn);
    row.appendChild(nigeBtn);
    container.appendChild(row);
  });
}

// ---------------------------
// 自分の現在地
// ---------------------------
let myStatus = "active";

function updateOwnMarker() {
  if (!currentPosition || !map) return;

  const icon = {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 13,
    fillColor: colorForPlayer(myJob, isAdmin, myStatus),
    fillOpacity: 1,
    strokeColor: "#ffffff",
    strokeWeight: 2
  };
  const label = labelForName(isAdmin ? "管理" : playerName);

  if (ownMarker) {
    ownMarker.setPosition(currentPosition);
    ownMarker.setIcon(icon);
    ownMarker.setLabel(label);
  } else {
    ownMarker = new google.maps.Marker({
      position: currentPosition,
      map,
      icon,
      label,
      title: "自分の現在地"
    });
  }
}

// 自分に割り振られた job（鬼/にげる）や status（捕まった/復活）の変化をリアルタイムで受け取り、
// 自分のマーカーの色に反映する（他の端末からの変更、リロード後の復元の両方に対応）
let ownStateListenerStarted = false;
function watchOwnState() {
  if (ownStateListenerStarted || isAdmin) return;
  ownStateListenerStarted = true;

  db.ref(`players/${userID}`).on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    if (data.job) myJob = data.job;
    if (data.status) myStatus = data.status;
    updateOwnMarker();
    updatePlayerControlsVisibility();
  });
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

      updateOwnMarker(); // 自分の表示は常に即座に更新（自分の画面だけ／他の人への共有は1分間隔）

      if (gameStarted) {
        checkZonePassing(); // ゲーム開始後だけチェックポイント通過を判定
      }
    },
    handleLocationError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

// 名前が確定し、地図の準備ができ次第呼ばれる。
// 他のプレイヤーへの位置共有(Firebaseへの書き込み)を指定間隔(既定1分)ごとに始める。
// ※ゲーム開始を待たず、サイトを開いた時点から常に共有する。
function beginTracking() {
  if (locationInterval) return; // 二重起動防止
  if (!identityReady) return; // 名前未確定なら開始しない

  watchOwnState();
  writeOwnPlayerState();
  locationInterval = setInterval(() => {
    writeOwnPlayerState();
  }, LOCATION_UPDATE_INTERVAL_MS);
}

function writeOwnPlayerState(extraState = {}) {
  if (!currentPosition || !identityReady) return;

  const payload = {
    userID,
    name: isAdmin ? "管理者" : playerName,
    isAdmin,
    position: currentPosition,
    updatedAt: Date.now(),
    ...extraState
  };

  // job（鬼/にげる）の初期値は最初の1回だけ書き込む。
  // それ以降は update() で他フィールドだけ更新するので、
  // 管理者が一覧から割り振った job を上書きしてしまうことはない。
  if (!hasSentInitialPlayerState) {
    payload.status = payload.status || "active";
    if (!isAdmin) {
      payload.job = "nige"; // 初期値は「にげる」。鬼だけ管理者が一覧から指定する
    }
    hasSentInitialPlayerState = true;
  }

  db.ref(`players/${userID}`).update(payload);
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
  myStatus = "caught";
  updateOwnMarker();
  writeOwnPlayerState({ status: "caught", caughtAt: Date.now() });
}

function markFree() {
  myStatus = "active";
  updateOwnMarker();
  writeOwnPlayerState({ status: "active", caughtAt: null, freedAt: Date.now() });
}

window.initMap = initMap;
