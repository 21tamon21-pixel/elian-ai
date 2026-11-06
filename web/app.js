const $ = id => document.getElementById(id);

let messages = [];
let recognition = null;
let listening = false;
let sessionActive = false;
let sending = false;
let speaking = false;
let interrupted = false;

let micStream = null;
let audioContext = null;
let analyser = null;
let animationFrame = null;

let sessionTimer = null;
let lastTranscript = "";
let lastTranscriptTime = 0;

let pendingSpeech = "";
let speechOffset = 0;
let voiceSpeed = Number(localStorage.getItem("elianSpeed") || 1);

const WAKE_PATTERN =
  /\b(?:hey\s+elian|hey\s+alien|elian|elien|elyan|ellian|elion|alien|a leon)\b/i;

const STOP_PATTERN =
  /\b(?:stop|stop talking|stop this conversation|end this conversation|end conversation|that's enough|thats enough|be quiet|quiet|shut up|cancel that|cancel this)\b/i;

const STOP_LISTENING_PATTERN =
  /\b(?:stop listening|turn off the microphone|go offline)\b/i;

const CONTINUE_PATTERN =
  /\b(?:continue|go on|carry on|resume|keep going)\b/i;

// Build the animated centre symbol.
for (let i = 0; i < 32; i++) {
  const ray = document.createElement("span");
  ray.className = "ray";
  ray.style.setProperty("--angle", `${i * 11.25}deg`);
  ray.style.setProperty("--delay", `${i * 0.035}s`);
  $("rays").append(ray);
}

const rays = [...document.querySelectorAll(".ray")];

function setState(state, hint) {
  $("state").textContent = state;
  $("hint").textContent = hint;

  const orb = $("orb");
  orb.classList.remove("listening", "speaking", "thinking");

  if (state === "Listening" || state === "Listening for command") {
    orb.classList.add("listening");
  } else if (state === "Speaking") {
    orb.classList.add("speaking");
  } else if (state === "Thinking") {
    orb.classList.add("thinking");
  }
}

function updateUsage(count, limit) {
  $("usage").textContent = `${count} / ${limit} prompts today`;
}

function drawMicrophone() {
  if (!listening || !analyser) return;

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  const step = Math.max(1, Math.floor(data.length / rays.length));

  rays.forEach((ray, index) => {
    const value = data[index * step] || 0;
    const level = 0.5 + (value / 255) * 2.1;
    ray.style.transform =
      `translate(-50%, -50%) rotate(${index * 11.25}deg) translateY(-54px) scaleY(${level})`;
  });

  animationFrame = requestAnimationFrame(drawMicrophone);
}

function stopVisualiser() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = null;

  rays.forEach((ray, index) => {
    ray.style.transform =
      `translate(-50%, -50%) rotate(${index * 11.25}deg) translateY(-54px) scaleY(.65)`;
  });
}

function startSessionTimer() {
  clearTimeout(sessionTimer);

  sessionTimer = setTimeout(() => {
    sessionActive = false;

    if (listening && !speaking) {
      setState("Listening", "Say Elian when you want me.");
    }
  }, 45000);
}

function stopSpeaking() {
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }

  speaking = false;
  interrupted = true;
  $("orb").classList.remove("speaking");
}

function speak(text, continuation = false, offset = 0) {
  if (!("speechSynthesis" in window)) return;

  if (!continuation) {
    pendingSpeech = text;
    speechOffset = 0;
  }

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = voiceSpeed;
  utterance.pitch = 0.96;
  utterance.lang = "en-GB";

  const voices = speechSynthesis.getVoices();
  const britishVoices = voices.filter(v => v.lang === "en-GB");

  const preferredVoice =
    britishVoices.find(v => /natural/i.test(v.name)) ||
    britishVoices.find(v => /google|sonia|ryan|daniel|serena|kate/i.test(v.name)) ||
    britishVoices[0];

  if (preferredVoice) utterance.voice = preferredVoice;

  utterance.onstart = () => {
    speaking = true;
    interrupted = false;
    setState("Speaking", "You can speak to stop me at any time.");
  };

  utterance.onboundary = event => {
    if (typeof event.charIndex === "number") {
      speechOffset = offset + event.charIndex +
        (event.charLength || 1);
    }
  };

  utterance.onend = () => {
    speaking = false;

    if (!interrupted) {
      pendingSpeech = "";
      speechOffset = 0;

      if (listening) {
        setState(
          sessionActive ? "Ready" : "Listening",
          sessionActive
            ? "Go ahead. I'm listening."
            : "Say Elian when you want me."
        );
      } else {
        setState("Ready", "Microphone is off.");
      }
    }
  };

  utterance.onerror = () => {
    speaking = false;

    if (!interrupted) {
      setState("Ready", "Waiting for your next instruction.");
    }
  };

  speechSynthesis.speak(utterance);
}

function resumeSpeech() {
  if (pendingSpeech && speechOffset < pendingSpeech.length) {
    const remaining = pendingSpeech.slice(speechOffset);
    const offset = speechOffset;
    speak(remaining, true, offset);
  } else if (sessionActive && !sending) {
    sendMessage("Continue your previous response.");
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToServer() {
  let attempts = 0;

  while (true) {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });

    if (response.ok) return await response.json();

    let errorData = {};
    try {
      errorData = await response.json();
    } catch {}

    const detail = errorData.detail;
    const message = typeof detail === "string"
      ? detail
      : detail?.message || "The request failed.";

    if (response.status === 429 && detail?.retryable && attempts < 3) {
      attempts++;

      const wait = Math.max(
        1,
        Number(response.headers.get("Retry-After")) ||
        Number(detail.retry_after) ||
        5
      );

      setState("Waiting", `Temporary rate limit. Retrying in ${wait} seconds.`);
      await sleep(wait * 1000);
      continue;
    }

    throw new Error(message);
  }
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || sending) return;

  stopSpeaking();
  sending = true;
  startSessionTimer();

  messages.push({ role: "user", content: text });

  setState("Thinking", "One moment.");

  try {
    const data = await sendToServer();

    messages.push({ role: "assistant", content: data.reply });

    // Keep a manageable amount of conversation context.
    messages = messages.slice(-20);

    updateUsage(data.prompts_today, data.daily_limit);
    speak(data.reply);

  } catch (error) {
    messages.pop();
    console.error(error);

    speak(
      "I couldn't complete that just now. Check the connection and try again."
    );

  } finally {
    sending = false;
  }
}

function handleTranscript(rawText, confidence = 0) {
  const text = rawText.trim();
  if (!text) return;

  // Ignore weak recognition results when the browser provides confidence.
  if (confidence > 0 && confidence < 0.48) return;

  // Prevent the same final transcript being processed twice.
  const now = Date.now();

  if (text.toLowerCase() === lastTranscript.toLowerCase() &&
      now - lastTranscriptTime < 1800) {
    return;
  }

  lastTranscript = text;
  lastTranscriptTime = now;

  // Stop listening completely if requested.
  if (STOP_LISTENING_PATTERN.test(text)) {
    stopListening();
    return;
  }

  // Stop commands work even without saying the wake word.
  if (STOP_PATTERN.test(text)) {
    sessionActive = false;
    clearTimeout(sessionTimer);
    stopSpeaking();
    setState("Stopped", "Say Elian when you're ready again.");
    return;
  }

  // Continue/resume commands work without another wake word.
  if (CONTINUE_PATTERN.test(text)) {
    resumeSpeech();
    return;
  }

  // Don't interpret Elian's own voice as a user command.
  if (speaking || sending) return;

  if (!sessionActive) {
    const match = text.match(WAKE_PATTERN);
    if (!match) return;

    sessionActive = true;
    startSessionTimer();

    const command = text
      .slice(match.index + match[0].length)
      .replace(/^[\s,.:;-]+/, "")
      .trim();

    if (command) {
      handleCommand(command);
    } else {
      speak("Yeah?");
      setState("Listening for command", "Go ahead.");
    }

    return;
  }

  startSessionTimer();

  // Ignore a likely recognition false positive after the wake word.
  if (/^(hi|hello|hey)$/i.test(text)) {
    setState("Listening for command", "I didn't quite catch that.");
    return;
  }

  handleCommand(text);
}

function handleCommand(text) {
  if (STOP_PATTERN.test(text)) {
    sessionActive = false;
    stopSpeaking();
    setState("Stopped", "Say Elian when you're ready again.");
    return;
  }

  if (CONTINUE_PATTERN.test(text)) {
    resumeSpeech();
    return;
  }

  sendMessage(text);
}

async function startListening() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    alert("Use Chrome or Edge for browser speech recognition.");
    return;
  }

  if (!window.isSecureContext) {
    alert("Open Elian using the secure HTTPS Codespaces address.");
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (AudioContextClass) {
      audioContext = new AudioContextClass();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;

      const source = audioContext.createMediaStreamSource(micStream);
      source.connect(analyser);

      drawMicrophone();
    }

    recognition = new SpeechRecognition();
    recognition.lang = "en-GB";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;

    recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];

        if (result.isFinal) {
          handleTranscript(
            result[0].transcript,
            result[0].confidence || 0
          );
        }
      }
    };

    recognition.onerror = event => {
      if (event.error === "not-allowed" ||
          event.error === "service-not-allowed") {
        setState("Microphone blocked", "Allow microphone access in browser settings.");
        stopListening();
      } else if (event.error !== "no-speech" &&
                 event.error !== "aborted") {
        setState("Microphone issue", `Speech recognition: ${event.error}`);
      }
    };

    listening = true;

    recognition.onend = () => {
      if (listening && recognition) {
        try {
          recognition.start();
        } catch {}
      }
    };

    recognition.start();

    $("mic").classList.add("active");
    $("micIcon").textContent = "■";
    $("micLabel").textContent = "LISTENING · SAY ELIAN TO WAKE";

    setState("Listening", "Say Elian when you want me.");

  } catch (error) {
    console.error(error);
    stopListening();

    setState("Microphone unavailable", "Allow microphone access and try again.");
    alert("Couldn't access the microphone: " + error.message);
  }
}

function stopListening() {
  listening = false;
  sessionActive = false;

  clearTimeout(sessionTimer);

  if (recognition) {
    const oldRecognition = recognition;
    recognition = null;
    oldRecognition.onend = null;

    try {
      oldRecognition.stop();
    } catch {}
  }

  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }

  stopVisualiser();

  $("mic").classList.remove("active");
  $("micIcon").textContent = "🎙";
  $("micLabel").textContent = "START LISTENING";

  setState("Ready", "Microphone is off.");
}

$("mic").onclick = () => {
  if (listening) stopListening();
  else startListening();
};

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    updateUsage(data.prompts_today, data.daily_limit);
  } catch {
    $("usage").textContent = "Usage unavailable";
  }
}

speechSynthesis.onvoiceschanged = () => {
  speechSynthesis.getVoices();
};

refreshStatus();
