// ============================================================================
// חידון כיתתי: לולאות for מקוננות בשפת C# - כיתה י' (מדעי המחשב א')
// מנוע משחק Kahoot כיתתי:
// - מסך מורה: בוחר משחק (1 או 2), מציג שאלות וחושף תשובות
// - QR Code לתלמידים בלבד: מוביל אך ורק למסך תלמיד ומחבר אוטומטית למשחק שהמורה בחר!
// ============================================================================

(function () {
  "use strict";

  const urlParams = new URLSearchParams(window.location.search);
  const isStudentMode =
    window.FORCE_STUDENT_MODE === true ||
    urlParams.get("role") === "student" ||
    window.location.pathname.toLowerCase().endsWith("student.html");

  const initialRoom = (urlParams.get("room") || "3H3T").toUpperCase();
  const rawGameParam = Number(urlParams.get("game") || window.DEFAULT_GAME_ID || 1);
  const initialGameId = [1, 2, 3].includes(rawGameParam) ? rawGameParam : 1;

  // אם זה מצב תלמיד – נועלים את הדף למצב תלמיד בלבד (מסתירים כל רכיב של מורה)
  if (isStudentMode) {
    document.body.classList.add("student-only-body");
  }

  const state = {
    role: isStudentMode ? "student" : "teacher",
    roomCode: initialRoom,
    gameId: initialGameId, // אצל תלמיד מתעדכן אוטומטית מהמורה!
    currentQuestionIndex: 0,
    isAnswerRevealed: false,
    questionStartTime: Date.now(),
    timerSeconds: 0,
    timerRemaining: 0,
    timerInterval: null,
    teacherSelectedOption: null,
    lanServerBaseUrl: "http://192.168.1.9:5050",
    apiBaseUrl: "",
    players: {},
    studentProfile: {
      id: "stu_" + Math.random().toString(36).substring(2, 9),
      name: "",
      avatar: "🦊",
      joined: false,
      selectedOption: null
    }
  };

  function getActiveQuestions() {
    if (window.QUIZ_SETS && window.QUIZ_SETS[state.gameId]) {
      return window.QUIZ_SETS[state.gameId].questions;
    }
    return window.QUIZ_QUESTIONS || [];
  }

  // ערוץ תקשורת מקומי בין חלונות באותו מחשב
  const broadcastChannel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("csharp_nested_for_quiz_" + state.roomCode)
      : null;

  let serverSyncAvailable = false;
  let mqttClient = null;
  const mqttTopic = `agy-csharp-quiz/v1/${state.roomCode}`;

  // אפקטים קוליים
  let audioCtx = null;
  function playTone(freq, durationMs, type = "sine", gainVal = 0.08) {
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(gainVal, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch (_) {}
  }

  function playRevealSound() {
    playTone(523.25, 130, "triangle", 0.1);
    setTimeout(() => playTone(659.25, 150, "triangle", 0.1), 110);
    setTimeout(() => playTone(783.99, 260, "triangle", 0.12), 230);
  }

  function playJoinSound() {
    playTone(440, 90, "sine", 0.06);
    setTimeout(() => playTone(587.33, 140, "sine", 0.07), 80);
  }

  // ============================================================================
  // הדגשת תחביר C#
  // ============================================================================
  function highlightCSharp(code) {
    if (!code) return "";
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return escaped
      .split("\n")
      .map((line) => {
        const commentIdx = line.indexOf("//");
        let codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
        const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : "";

        const strings = [];
        codePart = codePart.replace(/"([^"\\]|\\.)*"/g, (match) => {
          strings.push(match);
          return `___STR_${strings.length - 1}___`;
        });

        codePart = codePart
          .replace(/\b(public|static|for|if|else|break|continue|return|while|true|false)\b/g, '<span class="cs-kw">$1</span>')
          .replace(/\b(int|double|bool|string|char|void)\b/g, '<span class="cs-type">$1</span>')
          .replace(/\b(Console)\b/g, '<span class="cs-cls">$1</span>')
          .replace(/\b(WriteLine|Write|ReadLine|Substring|Length)\b/g, '<span class="cs-fn">$1</span>')
          .replace(/\b(\d+)\b/g, '<span class="cs-num">$1</span>');

        codePart = codePart.replace(/___STR_(\d+)___/g, (_, idx) => {
          return `<span class="cs-str">${strings[Number(idx)]}</span>`;
        });

        if (commentPart) {
          return codePart + `<span class="cs-cmt">${commentPart}</span>`;
        }
        return codePart;
      })
      .join("\n");
  }

  // ============================================================================
  // בניית כתובת ה-QR לתלמידים בלבד (student.html?room=XXXX)
  // ============================================================================
  function getStudentJoinUrl(forLocalWindow = false) {
    const query = `?room=${encodeURIComponent(state.roomCode)}&role=student`;

    if (forLocalWindow) {
      const basePath = window.location.pathname.replace(/[^/\\]*$/, "student.html");
      return `${window.location.origin === "null" ? "" : window.location.origin}${basePath}${query}`;
    }

    const proto = window.location.protocol;
    const host = window.location.hostname;
    if (proto === "file:" || host === "localhost" || host === "127.0.0.1") {
      return `${state.lanServerBaseUrl}/student.html${query}`;
    }

    const hostedStudentPath = window.location.pathname.replace(/[^/]*$/, "student.html");
    return `${window.location.origin}${hostedStudentPath}${query}`;
  }

  function renderAllQrCodes() {
    if (state.role !== "teacher") return;
    const qrJoinUrl = getStudentJoinUrl(false);

    const floatingBox = document.getElementById("floatingQrBox");
    const lobbyBox = document.getElementById("lobbyQrContainer");
    const modalBox = document.getElementById("modalQrBox");

    if (window.QRCodeHelper) {
      window.QRCodeHelper.render(floatingBox, qrJoinUrl);
      window.QRCodeHelper.render(lobbyBox, qrJoinUrl);
      window.QRCodeHelper.render(modalBox, qrJoinUrl);
    }

    const lobbyUrlEl = document.getElementById("lobbyJoinUrlText");
    const modalUrlEl = document.getElementById("modalJoinUrlText");
    if (lobbyUrlEl) lobbyUrlEl.textContent = qrJoinUrl;
    if (modalUrlEl) modalUrlEl.textContent = qrJoinUrl;

    const codeEls = [
      document.getElementById("floatingRoomCode"),
      document.getElementById("lobbyRoomCode"),
      document.getElementById("modalRoomCode")
    ];
    codeEls.forEach((el) => {
      if (el) el.textContent = state.roomCode;
    });
  }

  // ============================================================================
  // סנכרון זמן-אמת: המורה קובע את המשחק והשאלה, והתלמידים מתעדכנים אוטומטית
  // ============================================================================
  function initMqttRelay() {
    if (typeof window.mqtt === "undefined") return;
    try {
      mqttClient = window.mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
        clientId: "agy_quiz_" + Math.random().toString(16).slice(2, 10),
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 3000
      });

      mqttClient.on("connect", () => {
        mqttClient.subscribe(mqttTopic, { qos: 0 });
        if (state.role === "teacher") {
          broadcastStateFromTeacher();
        } else {
          sendStudentEventToTeacher({ type: "REQUEST_STATE" });
        }
      });

      mqttClient.on("message", (topic, payloadBuffer) => {
        if (topic !== mqttTopic) return;
        try {
          const msg = JSON.parse(payloadBuffer.toString());
          handleIncomingMessage(msg);
        } catch (_) {}
      });
    } catch (_) {}
  }

  function broadcastStateFromTeacher() {
    if (state.role !== "teacher") return;
    const payload = {
      type: "ROOM_STATE",
      roomCode: state.roomCode,
      gameId: state.gameId,
      currentQuestionIndex: state.currentQuestionIndex,
      isAnswerRevealed: state.isAnswerRevealed,
      questionStartTime: state.questionStartTime,
      players: state.players,
      timestamp: Date.now()
    };

    const jsonStr = JSON.stringify(payload);

    if (broadcastChannel) {
      broadcastChannel.postMessage(payload);
    }
    try {
      localStorage.setItem("quiz_room_" + state.roomCode, jsonStr);
    } catch (_) {}

    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(mqttTopic, jsonStr, { qos: 0, retain: true });
    }

    if (serverSyncAvailable) {
      fetch(`${state.apiBaseUrl}/api/room/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonStr
      }).catch(() => {});
    }
  }

  function sendStudentEventToTeacher(eventData) {
    const msg = { ...eventData, roomCode: state.roomCode, timestamp: Date.now() };
    const jsonStr = JSON.stringify(msg);

    if (broadcastChannel) {
      broadcastChannel.postMessage(msg);
    }
    try {
      localStorage.setItem("quiz_stu_evt_" + state.roomCode, jsonStr);
    } catch (_) {}

    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(mqttTopic, jsonStr, { qos: 0 });
    }

    if (serverSyncAvailable) {
      fetch(`${state.apiBaseUrl}/api/room/student-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonStr
      }).catch(() => {});
    }
  }

  function handleIncomingMessage(msg) {
    if (!msg || msg.roomCode !== state.roomCode) return;

    if (state.role === "teacher") {
      if (msg.type === "STUDENT_JOIN") {
        const p = msg.player;
        if (!p || !p.id) return;
        if (!state.players[p.id]) {
          state.players[p.id] = {
            id: p.id,
            name: p.name,
            avatar: p.avatar || "🦊",
            score: 0,
            streak: 0,
            currentAnswer: null,
            answerTimeMs: 0,
            isBot: false
          };
          playJoinSound();
        } else {
          state.players[p.id].name = p.name;
          state.players[p.id].avatar = p.avatar || state.players[p.id].avatar;
        }
        updatePlayersUI();
        broadcastStateFromTeacher();
      } else if (msg.type === "STUDENT_ANSWER") {
        const player = state.players[msg.playerId];
        if (player && !state.isAnswerRevealed && player.currentAnswer === null) {
          player.currentAnswer = msg.optionIndex;
          player.answerTimeMs = Math.max(300, Date.now() - state.questionStartTime);
          updateAnsweredCounterUI();
          broadcastStateFromTeacher();
        }
      } else if (msg.type === "REQUEST_STATE") {
        broadcastStateFromTeacher();
      }
    } else if (state.role === "student") {
      if (msg.type === "ROOM_STATE") {
        const gameChanged = msg.gameId && state.gameId !== msg.gameId;
        const questionChanged =
          state.currentQuestionIndex !== msg.currentQuestionIndex || gameChanged;
        const revealChanged = state.isAnswerRevealed !== msg.isAnswerRevealed;

        // התלמיד מסתנכרן אוטומטית למשחק שהמורה בחר!
        if (msg.gameId) {
          state.gameId = msg.gameId;
        }
        state.currentQuestionIndex = msg.currentQuestionIndex || 0;
        state.isAnswerRevealed = Boolean(msg.isAnswerRevealed);
        state.players = msg.players || {};

        if (questionChanged) {
          state.studentProfile.selectedOption = null;
        }

        if (state.studentProfile.joined) {
          if (questionChanged || revealChanged) {
            renderStudentView();
          } else {
            updateStudentScoreStrip();
          }
        }
      }
    }
  }

  if (broadcastChannel) {
    broadcastChannel.onmessage = (ev) => handleIncomingMessage(ev.data);
  }

  window.addEventListener("storage", (ev) => {
    if (!ev.newValue) return;
    try {
      const parsed = JSON.parse(ev.newValue);
      handleIncomingMessage(parsed);
    } catch (_) {}
  });

  function probeLocalCSharpServer() {
    const candidates =
      window.location.protocol === "file:"
        ? ["http://localhost:5050", "http://192.168.1.9:5050"]
        : ["", "http://localhost:5050", "http://192.168.1.9:5050"];

    function tryNext(idx) {
      if (idx >= candidates.length) return;
      const base = candidates[idx];
      fetch(`${base}/api/room/ping`)
        .then((r) => r.json())
        .then((info) => {
          if (info && info.ok) {
            serverSyncAvailable = true;
            state.apiBaseUrl = base;
            if (info.lanUrl) {
              state.lanServerBaseUrl = info.lanUrl;
              renderAllQrCodes();
            }
            if (state.role === "teacher") {
              broadcastStateFromTeacher();
            } else {
              sendStudentEventToTeacher({ type: "REQUEST_STATE" });
            }
            setInterval(() => {
              fetch(`${state.apiBaseUrl}/api/room/poll?room=${state.roomCode}&role=${state.role}`)
                .then((res) => res.json())
                .then((data) => {
                  if (data && data.messages) {
                    data.messages.forEach(handleIncomingMessage);
                  }
                })
                .catch(() => {});
            }, 800);
          }
        })
        .catch(() => {
          tryNext(idx + 1);
        });
    }

    tryNext(0);
  }

  // ============================================================================
  // החלפת משחק ע"י המורה בלבד (משחק 1 / משחק 2 / משחק 3)
  // ============================================================================
  function switchGameSet(newGameId) {
    if (state.role !== "teacher") return;
    const parsedId = Number(newGameId);
    const id = [1, 2, 3].includes(parsedId) ? parsedId : 1;
    state.gameId = id;

    document.querySelectorAll(".game-switch-btn, .lobby-game-card").forEach((btn) => {
      const g = Number(btn.getAttribute("data-game"));
      btn.classList.toggle("active", g === id);
    });

    const subTitle = document.getElementById("brandSubTitle");
    if (subTitle) {
      const setMeta = window.QUIZ_SETS && window.QUIZ_SETS[id];
      subTitle.textContent = setMeta && setMeta.gradeSubtitle
        ? setMeta.gradeSubtitle
        : id === 3
          ? "כיתה י\"א – רקורסיה בשפת C# (15 שאלות)"
          : `כיתה י' – לולאות for מקוננות ב-C# (משחק ${id})`;
    }

    renderAllQrCodes();
    goToQuestion(0);
  }

  // ============================================================================
  // רינדור הלוח הכיתתי של המורה
  // ============================================================================
  function renderProgressSegments() {
    if (state.role !== "teacher") return;
    const questions = getActiveQuestions();
    const total = questions.length;
    const container = document.getElementById("progressSegments");
    if (!container) return;
    container.innerHTML = "";

    for (let i = 0; i < total; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prog-seg";
      if (i < state.currentQuestionIndex) btn.classList.add("done");
      if (i === state.currentQuestionIndex) btn.classList.add("active");
      btn.title = `מעבר לשאלה ${i + 1}`;
      btn.addEventListener("click", () => {
        goToQuestion(i);
      });
      container.appendChild(btn);
    }
  }

  function renderTeacherQuestion() {
    if (state.role !== "teacher") return;
    const questions = getActiveQuestions();
    const total = questions.length;
    const q = questions[state.currentQuestionIndex];
    if (!q) return;

    renderProgressSegments();

    const counterPill = document.getElementById("questionCounterPill");
    if (counterPill) {
      counterPill.textContent = `שאלה ${state.currentQuestionIndex + 1} מתוך ${total}`;
    }

    document.getElementById("questionTopicTag").textContent = `משחק ${state.gameId} • ${q.topic}`;
    document.getElementById("questionMainTitle").textContent = q.question;

    const codeWrapper = document.getElementById("codeBlockWrapper");
    const codeContent = document.getElementById("questionCodeContent");
    if (q.code) {
      codeWrapper.classList.remove("hidden");
      codeContent.innerHTML = highlightCSharp(q.code);
    } else {
      codeWrapper.classList.add("hidden");
      codeContent.innerHTML = "";
    }

    for (let i = 0; i < 4; i++) {
      const card = document.getElementById(`optionCard${i}`);
      const textEl = document.getElementById(`optionText${i}`);
      const statsEl = document.getElementById(`optionStats${i}`);

      textEl.textContent = q.options[i];
      card.classList.remove("selected-by-teacher", "correct-revealed", "wrong-revealed");
      statsEl.classList.add("hidden");

      if (state.teacherSelectedOption === i && !state.isAnswerRevealed) {
        card.classList.add("selected-by-teacher");
      }

      if (state.isAnswerRevealed) {
        if (i === q.correctIndex) {
          card.classList.add("correct-revealed");
        } else {
          card.classList.add("wrong-revealed");
        }
        const countForOption = Object.values(state.players).filter(
          (p) => p.currentAnswer === i
        ).length;
        statsEl.classList.remove("hidden");
        document.getElementById(`votesCount${i}`).textContent =
          countForOption === 1 ? "תלמיד 1 בחר בתשובה זו" : `${countForOption} תלמידים בחרו בתשובה זו`;
      }
    }

    const expBanner = document.getElementById("explanationBanner");
    const expText = document.getElementById("explanationText");
    if (state.isAnswerRevealed) {
      expText.textContent = q.explanation;
      expBanner.classList.remove("hidden");
    } else {
      expBanner.classList.add("hidden");
    }

    const btnMain = document.getElementById("btnRevealOrNext");
    if (!state.isAnswerRevealed) {
      btnMain.textContent = "חשיפת התשובה";
    } else if (state.currentQuestionIndex < total - 1) {
      btnMain.textContent = "לשאלה הבאה ⬅️";
    } else {
      btnMain.textContent = "🏆 סיום ופודיום מנצחים!";
    }

    updateAnsweredCounterUI();
  }

  function updateAnsweredCounterUI() {
    if (state.role !== "teacher") return;
    const playerList = Object.values(state.players);
    const totalPlayers = playerList.length;
    const answeredCount = playerList.filter((p) => p.currentAnswer !== null).length;

    const ratioEl = document.getElementById("answeredRatioText");
    if (ratioEl) {
      ratioEl.textContent = `${answeredCount} / ${totalPlayers}`;
    }

    const connectedLabel = document.getElementById("connectedCountLabel");
    if (connectedLabel) {
      connectedLabel.textContent = `${totalPlayers} מחוברים`;
    }

    const lobbyCount = document.getElementById("lobbyPlayersCount");
    if (lobbyCount) {
      lobbyCount.textContent = String(totalPlayers);
    }
  }

  function updatePlayersUI() {
    if (state.role !== "teacher") return;
    updateAnsweredCounterUI();

    const lobbyList = document.getElementById("lobbyPlayersList");
    if (!lobbyList) return;

    const playersArr = Object.values(state.players);
    if (playersArr.length === 0) {
      lobbyList.innerHTML = `
        <div class="empty-players-msg">
          ממתין להצטרפות תלמידים...<br/>
          <small>תלמידים סורקים את ה-QR בפינת המסך ומצטרפים ישירות למשחק שבחרתם!</small>
        </div>`;
      return;
    }

    lobbyList.innerHTML = playersArr
      .map(
        (p) =>
          `<div class="player-chip"><span>${p.avatar}</span><span>${p.name}</span></div>`
      )
      .join("");
  }

  function revealCurrentAnswer() {
    if (state.role !== "teacher" || state.isAnswerRevealed) return;
    state.isAnswerRevealed = true;
    stopQuestionTimer();

    const questions = getActiveQuestions();
    const q = questions[state.currentQuestionIndex];
    if (!q) return;

    Object.values(state.players).forEach((p) => {
      if (p.currentAnswer === q.correctIndex) {
        p.streak = (p.streak || 0) + 1;
        const speedFactor = Math.max(0, 1 - Math.min(p.answerTimeMs || 5000, 20000) / 25000);
        const speedBonus = Math.round(speedFactor * 400);
        const streakBonus = Math.min((p.streak - 1) * 100, 300);
        const earned = 600 + speedBonus + streakBonus;
        p.lastEarned = earned;
        p.score += earned;
      } else {
        p.streak = 0;
        p.lastEarned = 0;
      }
    });

    playRevealSound();
    renderTeacherQuestion();
    broadcastStateFromTeacher();
  }

  function goToQuestion(index) {
    if (state.role !== "teacher") return;
    const questions = getActiveQuestions();
    const total = questions.length;
    if (index < 0 || index >= total) return;

    state.currentQuestionIndex = index;
    state.isAnswerRevealed = false;
    state.teacherSelectedOption = null;
    state.questionStartTime = Date.now();

    Object.values(state.players).forEach((p) => {
      p.currentAnswer = null;
      p.answerTimeMs = 0;
      p.lastEarned = 0;
    });

    startQuestionTimerIfEnabled();
    scheduleBotAnswers();
    renderTeacherQuestion();
    broadcastStateFromTeacher();
  }

  function stopQuestionTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    const pill = document.getElementById("boardTimerPill");
    if (pill) pill.classList.add("hidden");
  }

  function startQuestionTimerIfEnabled() {
    stopQuestionTimer();
    if (!state.timerSeconds || state.timerSeconds <= 0) return;

    state.timerRemaining = state.timerSeconds;
    const pill = document.getElementById("boardTimerPill");
    const txt = document.getElementById("boardTimerText");
    if (pill && txt) {
      pill.classList.remove("hidden");
      txt.textContent = String(state.timerRemaining);
    }

    state.timerInterval = setInterval(() => {
      state.timerRemaining--;
      if (txt) txt.textContent = String(Math.max(0, state.timerRemaining));
      if (state.timerRemaining <= 0) {
        stopQuestionTimer();
        revealCurrentAnswer();
      }
    }, 1000);
  }

  const DEMO_STUDENTS = [
    { name: "נועה כ.", avatar: "🦊" },
    { name: "איתי ל.", avatar: "🦁" },
    { name: "מאיה ש.", avatar: "🐼" },
    { name: "דניאל ר.", avatar: "🐯" },
    { name: "יובל מ.", avatar: "🐸" },
    { name: "רוני א.", avatar: "🚀" }
  ];

  function addDemoStudents() {
    if (state.role !== "teacher") return;
    DEMO_STUDENTS.forEach((d, idx) => {
      const id = "bot_" + idx;
      if (!state.players[id]) {
        state.players[id] = {
          id,
          name: d.name,
          avatar: d.avatar,
          score: 0,
          streak: 0,
          currentAnswer: null,
          answerTimeMs: 0,
          isBot: true
        };
      }
    });
    playJoinSound();
    updatePlayersUI();
    scheduleBotAnswers();
    broadcastStateFromTeacher();
  }

  function scheduleBotAnswers() {
    if (state.role !== "teacher") return;
    const questions = getActiveQuestions();
    const q = questions[state.currentQuestionIndex];
    if (!q) return;
    const qIdxAtSchedule = state.currentQuestionIndex;
    const gameIdAtSchedule = state.gameId;

    Object.values(state.players).forEach((p) => {
      if (!p.isBot || p.currentAnswer !== null) return;
      const delay = 1400 + Math.floor(Math.random() * 4200);
      setTimeout(() => {
        if (
          state.gameId !== gameIdAtSchedule ||
          state.currentQuestionIndex !== qIdxAtSchedule ||
          state.isAnswerRevealed ||
          p.currentAnswer !== null
        ) {
          return;
        }
        const isCorrect = Math.random() < 0.72;
        const chosen = isCorrect
          ? q.correctIndex
          : (q.correctIndex + 1 + Math.floor(Math.random() * 3)) % 4;
        p.currentAnswer = chosen;
        p.answerTimeMs = delay;
        updateAnsweredCounterUI();
        broadcastStateFromTeacher();
      }, delay);
    });
  }

  // ============================================================================
  // מסך התלמיד בלבד (מחובר למשחק שהמורה בחר!)
  // ============================================================================
  function renderStudentView() {
    const questions = getActiveQuestions();
    const total = questions.length;
    const q = questions[state.currentQuestionIndex];
    if (!q) return;

    document.getElementById("studentQNumber").textContent = `שאלה ${
      state.currentQuestionIndex + 1
    } מתוך ${total}`;
    document.getElementById("studentQTopic").textContent = q.topic;
    document.getElementById("studentQTitle").textContent = q.question;

    const codeWrap = document.getElementById("studentCodeWrapper");
    const codeContent = document.getElementById("studentCodeContent");
    if (q.code) {
      codeWrap.classList.remove("hidden");
      codeContent.innerHTML = highlightCSharp(q.code);
    } else {
      codeWrap.classList.add("hidden");
    }

    for (let i = 0; i < 4; i++) {
      document.getElementById(`studentOpt${i}`).textContent = q.options[i];
    }

    const ansBtns = document.querySelectorAll(".student-ans-btn");
    ansBtns.forEach((btn) => {
      const idx = Number(btn.getAttribute("data-index"));
      btn.classList.toggle("chosen", state.studentProfile.selectedOption === idx);
      btn.disabled = state.studentProfile.selectedOption !== null || state.isAnswerRevealed;
    });

    const fbBox = document.getElementById("studentFeedbackBox");
    const fbEmoji = document.getElementById("studentFeedbackEmoji");
    const fbTitle = document.getElementById("studentFeedbackTitle");
    const fbSub = document.getElementById("studentFeedbackSub");

    if (state.isAnswerRevealed) {
      fbBox.classList.remove("hidden", "correct", "wrong");
      const letters = ["א", "ב", "ג", "ד"];
      if (state.studentProfile.selectedOption === q.correctIndex) {
        fbBox.classList.add("correct");
        fbEmoji.textContent = "🎉";
        const myServerRecord = state.players[state.studentProfile.id];
        const earned = myServerRecord && myServerRecord.lastEarned ? myServerRecord.lastEarned : 750;
        fbTitle.textContent = `תשובה נכונה! +${earned} נקודות`;
        fbSub.textContent = q.explanation;
      } else {
        fbBox.classList.add("wrong");
        fbEmoji.textContent = "💡";
        fbTitle.textContent = `התשובה הנכונה היא ${letters[q.correctIndex]}`;
        fbSub.textContent = q.explanation;
      }
    } else if (state.studentProfile.selectedOption !== null) {
      fbBox.classList.remove("hidden", "correct", "wrong");
      fbEmoji.textContent = "⏳";
      fbTitle.textContent = "התשובה נקלטה בלוח!";
      fbSub.textContent = "ממתין שהמורה יחשוף את התשובה...";
    } else {
      fbBox.classList.add("hidden");
    }

    updateStudentScoreStrip();
  }

  function updateStudentScoreStrip() {
    const me = state.players[state.studentProfile.id];
    if (me) {
      document.getElementById("studentScoreDisplay").textContent = String(me.score || 0);
      const streakPill = document.getElementById("studentStreakPill");
      if (me.streak && me.streak >= 2) {
        streakPill.classList.remove("hidden");
        streakPill.textContent = `🔥 ${me.streak}`;
      } else {
        streakPill.classList.add("hidden");
      }
    }
  }

  // ============================================================================
  // טבלת מובילים ופודיום (למורה)
  // ============================================================================
  function openLeaderboardModal(isFinal = false) {
    if (state.role !== "teacher") return;
    const questions = getActiveQuestions();
    const total = questions.length;
    const modal = document.getElementById("leaderboardModal");
    const titleEl = document.getElementById("leaderboardModalTitle");
    titleEl.textContent = isFinal
      ? `🏆 סיום משחק ${state.gameId} – פודיום המנצחים של כיתה י'!`
      : `🏆 טבלת מובילים – משחק ${state.gameId} (שאלה ${state.currentQuestionIndex + 1} מתוך ${total})`;

    const sorted = Object.values(state.players).sort((a, b) => b.score - a.score);

    const p1 = sorted[0];
    const p2 = sorted[1];
    const p3 = sorted[2];

    document.getElementById("podium1Avatar").textContent = p1 ? p1.avatar : "🥇";
    document.getElementById("podium1Name").textContent = p1 ? p1.name : "מקום 1";
    document.getElementById("podium1Score").textContent = p1 ? `${p1.score} נק'` : "0 נק'";

    document.getElementById("podium2Avatar").textContent = p2 ? p2.avatar : "🥈";
    document.getElementById("podium2Name").textContent = p2 ? p2.name : "מקום 2";
    document.getElementById("podium2Score").textContent = p2 ? `${p2.score} נק'` : "0 נק'";

    document.getElementById("podium3Avatar").textContent = p3 ? p3.avatar : "🥉";
    document.getElementById("podium3Name").textContent = p3 ? p3.name : "מקום 3";
    document.getElementById("podium3Score").textContent = p3 ? `${p3.score} נק'` : "0 נק'";

    const listEl = document.getElementById("rankingsList");
    if (sorted.length === 0) {
      listEl.innerHTML = `<div class="empty-players-msg">טרם הצטרפו תלמידים. התלמידים סורקים את ה-QR בפינת המסך כדי להצטרף!</div>`;
    } else {
      listEl.innerHTML = sorted
        .map(
          (p, i) => `
          <div class="ranking-row">
            <div class="ranking-left">
              <span class="rank-num">${i + 1}</span>
              <span>${p.avatar}</span>
              <span>${p.name}</span>
              ${p.streak >= 2 ? `<span class="streak-pill">🔥 ${p.streak}</span>` : ""}
            </div>
            <div>${p.score} נקודות</div>
          </div>`
        )
        .join("");
    }

    modal.classList.remove("hidden");
    if (isFinal) {
      launchConfetti();
    }
  }

  function launchConfetti() {
    const canvas = document.getElementById("confettiCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const pieces = Array.from({ length: 110 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * -canvas.height,
      size: 6 + Math.random() * 7,
      color: ["#3b82f6", "#f59e0b", "#10b981", "#a855f7", "#ef4444"][
        Math.floor(Math.random() * 5)
      ],
      speedY: 2.5 + Math.random() * 4,
      speedX: -2 + Math.random() * 4,
      rot: Math.random() * Math.PI
    }));

    let frames = 0;
    function step() {
      frames++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach((p) => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.rot += 0.05;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      });
      if (frames < 220) {
        requestAnimationFrame(step);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    requestAnimationFrame(step);
  }

  function showView(viewName) {
    const homeView = document.getElementById("homeView");
    const teacherQuizView = document.getElementById("teacherQuizView");
    const studentJoinView = document.getElementById("studentJoinView");
    const studentPlayView = document.getElementById("studentPlayView");
    const floatingQr = document.getElementById("floatingQrCard");

    if (homeView) homeView.classList.add("hidden");
    if (teacherQuizView) teacherQuizView.classList.add("hidden");
    if (studentJoinView) studentJoinView.classList.add("hidden");
    if (studentPlayView) studentPlayView.classList.add("hidden");
    if (floatingQr) floatingQr.classList.add("hidden");

    if (state.role === "student") {
      // תלמיד לעולם לא רואה מסכי מורה!
      if (viewName === "studentPlay") {
        studentPlayView.classList.remove("hidden");
        renderStudentView();
      } else {
        studentJoinView.classList.remove("hidden");
      }
      return;
    }

    if (viewName === "home") {
      homeView.classList.remove("hidden");
    } else if (viewName === "teacherBoard") {
      teacherQuizView.classList.remove("hidden");
      floatingQr.classList.remove("hidden");
      renderTeacherQuestion();
    }
  }

  function initTeacherEvents() {
    document.querySelectorAll(".game-switch-btn, .lobby-game-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = Number(btn.getAttribute("data-game"));
        switchGameSet(g);
      });
    });

    const btnHome = document.getElementById("btnHome");
    if (btnHome) {
      btnHome.addEventListener("click", () => showView("home"));
    }

    const btnConnected = document.getElementById("btnConnectedPlayers");
    if (btnConnected) {
      btnConnected.addEventListener("click", () => openLeaderboardModal(false));
    }

    const btnFullscreen = document.getElementById("btnFullscreen");
    if (btnFullscreen) {
      btnFullscreen.addEventListener("click", () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });
    }

    for (let i = 0; i < 4; i++) {
      const card = document.getElementById(`optionCard${i}`);
      if (card) {
        card.addEventListener("click", () => {
          if (state.isAnswerRevealed) return;
          state.teacherSelectedOption = i;
          renderTeacherQuestion();
        });
      }
    }

    document.getElementById("btnRevealOrNext").addEventListener("click", () => {
      const total = getActiveQuestions().length;
      if (!state.isAnswerRevealed) {
        revealCurrentAnswer();
      } else if (state.currentQuestionIndex < total - 1) {
        goToQuestion(state.currentQuestionIndex + 1);
      } else {
        openLeaderboardModal(true);
      }
    });

    document.getElementById("btnSkipQuestion").addEventListener("click", () => {
      const total = getActiveQuestions().length;
      if (state.currentQuestionIndex < total - 1) {
        goToQuestion(state.currentQuestionIndex + 1);
      } else {
        goToQuestion(0);
      }
    });

    document.getElementById("btnLeaderboardQuick").addEventListener("click", () => {
      openLeaderboardModal(false);
    });

    document.getElementById("btnCloseLeaderboard").addEventListener("click", () => {
      document.getElementById("leaderboardModal").classList.add("hidden");
    });

    document.getElementById("btnContinueFromLeaderboard").addEventListener("click", () => {
      document.getElementById("leaderboardModal").classList.add("hidden");
    });

    document.getElementById("btnAddDemoFromModal").addEventListener("click", () => {
      addDemoStudents();
      openLeaderboardModal(false);
    });

    document.getElementById("floatingQrCard").addEventListener("click", () => {
      document.getElementById("qrJoinModal").classList.remove("hidden");
    });

    document.getElementById("btnCloseQrModal").addEventListener("click", () => {
      document.getElementById("qrJoinModal").classList.add("hidden");
    });

    document.getElementById("btnModalOpenStudent").addEventListener("click", () => {
      window.open(getStudentJoinUrl(true), "_blank", "width=460,height=760");
    });

    document.getElementById("btnOpenStudentTab").addEventListener("click", () => {
      window.open(getStudentJoinUrl(true), "_blank", "width=460,height=760");
    });

    document.getElementById("btnAddDemoStudents").addEventListener("click", () => {
      addDemoStudents();
    });

    document.getElementById("btnClearPlayers").addEventListener("click", () => {
      state.players = {};
      updatePlayersUI();
      broadcastStateFromTeacher();
    });

    document.getElementById("timerSelect").addEventListener("change", (ev) => {
      state.timerSeconds = Number(ev.target.value) || 0;
    });

    document.getElementById("btnStartQuiz").addEventListener("click", () => {
      showView("teacherBoard");
      goToQuestion(0);
    });

    document.getElementById("btnResumeQuiz").addEventListener("click", () => {
      showView("teacherBoard");
    });

    window.addEventListener("keydown", (ev) => {
      if (state.role !== "teacher") return;
      if (ev.target && ["INPUT", "SELECT", "TEXTAREA"].includes(ev.target.tagName)) return;

      const total = getActiveQuestions().length;
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        document.getElementById("btnRevealOrNext").click();
      } else if (ev.key === "ArrowLeft" && state.currentQuestionIndex < total - 1) {
        goToQuestion(state.currentQuestionIndex + 1);
      } else if (ev.key === "ArrowRight" && state.currentQuestionIndex > 0) {
        goToQuestion(state.currentQuestionIndex - 1);
      }
    });
  }

  function initStudentEvents() {
    const joinRoomBadge = document.getElementById("joinScreenRoomCode");
    if (joinRoomBadge) joinRoomBadge.textContent = state.roomCode;

    const studentRoomDisp = document.getElementById("studentRoomDisplay");
    if (studentRoomDisp) studentRoomDisp.textContent = state.roomCode;

    document.querySelectorAll(".avatar-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".avatar-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        state.studentProfile.avatar = btn.getAttribute("data-avatar");
      });
    });

    const form = document.getElementById("studentJoinForm");
    if (form) {
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const nameVal = document.getElementById("inputStudentName").value.trim();
        if (!nameVal) return;

        state.studentProfile.name = nameVal;
        state.studentProfile.joined = true;

        document.getElementById("studentAvatarDisplay").textContent = state.studentProfile.avatar;
        document.getElementById("studentNameDisplay").textContent = state.studentProfile.name;
        document.getElementById("studentRoomDisplay").textContent = state.roomCode;

        // קריאת המצב הנוכחי של החדר מהמורה (כולל איזה משחק המורה בחר!)
        try {
          const saved = localStorage.getItem("quiz_room_" + state.roomCode);
          if (saved) {
            handleIncomingMessage(JSON.parse(saved));
          }
        } catch (_) {}

        sendStudentEventToTeacher({
          type: "STUDENT_JOIN",
          player: {
            id: state.studentProfile.id,
            name: state.studentProfile.name,
            avatar: state.studentProfile.avatar
          }
        });

        sendStudentEventToTeacher({ type: "REQUEST_STATE" });
        showView("studentPlay");
      });
    }

    document.querySelectorAll(".student-ans-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.isAnswerRevealed || state.studentProfile.selectedOption !== null) return;
        const idx = Number(btn.getAttribute("data-index"));
        state.studentProfile.selectedOption = idx;

        playTone(600, 100, "sine", 0.08);
        sendStudentEventToTeacher({
          type: "STUDENT_ANSWER",
          playerId: state.studentProfile.id,
          optionIndex: idx
        });

        renderStudentView();
      });
    });
  }

  function init() {
    initMqttRelay();
    probeLocalCSharpServer();

    if (state.role === "student") {
      // מצב תלמיד בלבד: טוען את המצב מהמורה ומציג רק מסך הזנת שם לתלמיד
      try {
        const saved = localStorage.getItem("quiz_room_" + state.roomCode);
        if (saved) {
          handleIncomingMessage(JSON.parse(saved));
        }
      } catch (_) {}
      initStudentEvents();
      showView("studentJoin");
    } else {
      // מצב מורה
      initTeacherEvents();
      switchGameSet(state.gameId);
      renderAllQrCodes();
      updatePlayersUI();
      showView("teacherBoard");
      broadcastStateFromTeacher();
    }
  }

  init();
})();
