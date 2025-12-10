import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Upload,
  Globe,
  Video,
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Settings,
  Camera,
  Circle,
  StopCircle,
} from "lucide-react";
import { translations } from "./translations";

const SignLanguageTranslator = () => {
  // Initialize language from localStorage or default to 'en'
  const [lang, setLang] = useState(() => {
    try {
      const savedLang = localStorage.getItem("preferredLanguage");
      return (savedLang === "en" || savedLang === "de") ? savedLang : "en";
    } catch (e) {
      console.warn("[language] failed to load preference", e);
      return "en";
    }
  });
  // Save language preference to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem("preferredLanguage", lang);
    } catch (e) {
      console.warn("[language] failed to save preference", e);
    }
  }, [lang]);

  // t(key, ...args) supports simple numeric placeholders {0}, {1}, ...
  const t = (key, ...args) => {
    const s =
      (translations[lang] && translations[lang][key]) ||
      translations.en[key] ||
      key;
    if (!args || args.length === 0) return s;
    return s.replace(/\{(\d+)\}/g, (m, idx) => {
      const i = parseInt(idx, 10);
      return typeof args[i] !== "undefined" ? String(args[i]) : m;
    });
  };

  const [file, setFile] = useState(null);
  const [inputMode, setInputMode] = useState("record"); // 'upload' or 'record'
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStage, setCurrentStage] = useState("");
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [selectedMethod, setSelectedMethod] = useState("reranked_s2g_beam_g2t");
  const [extractionLog, setExtractionLog] = useState([]);
  // Translation history (up to 10 recent records), persisted in localStorage
  const [translationHistory, setTranslationHistory] = useState([]);
  
  // Text-to-speech states (separate for each section)
  const [germanResultsSpeaking, setGermanResultsSpeaking] = useState(false);
  const [translationFeatureSpeaking, setTranslationFeatureSpeaking] = useState(false);
  const [historySpeakingId, setHistorySpeakingId] = useState(null);
  
  // Copy-to-clipboard states (separate for each section)
  const [germanResultsCopiedId, setGermanResultsCopiedId] = useState(null);
  const [translationFeatureCopiedId, setTranslationFeatureCopiedId] = useState(null);
  const [historyCopiedId, setHistoryCopiedId] = useState(null);
  
  // Store translated results from TranslationFeature section
  const [translationFeatureState, setTranslationFeatureState] = useState({
    targetLang: 'en',
    translatedText: '',
    isTranslating: false,
    error: null,
  });
  
  const utteranceRef = useRef(null);
  const germanResultsCopyTimerRef = useRef(null);
  const translationFeatureCopyTimerRef = useRef(null);
  const historyCopyTimerRef = useRef(null);

  // Webcam/Recording States
  const [isRecording, setIsRecording] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const stopRecordingRef = useRef(null);

  const fileInputRef = useRef(null);
  const videoRef = useRef(null); // Used for both upload preview and landmark processing
  const webcamVideoRef = useRef(null); // Only for the live camera feed
  const canvasRef = useRef(null);
  const previewUrlRef = useRef(null);
  const [, forceRerender] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const countdownTimerRef = useRef(null);
  const recordingTimeoutRef = useRef(null);
  
  // Real-time landmark extraction during recording
  const realtimeLandmarksRef = useRef([]);
  const mediapipeHandsRef = useRef(null);
  const landmarkExtractionIntervalRef = useRef(null);

  const translationMethods = React.useMemo(
    () =>
      (translations[lang] && translations[lang].translationMethods) ||
      translations.en.translationMethods,
    [lang]
  );

  const CONFIG = {
    IMG_SIZE: [224, 224],
    TARGET_FPS: 25,
    MAX_SEQ_LEN: 190,
    BACKEND_URL: "https://suencheah-DGS-CSLT-backend.hf.space/api/translate_landmarks",
    RECORD_MAX_SECONDS: 8,
  };

  // Default recording length used when CONFIG isn't referenced in hook deps
  const DEFAULT_RECORD_MAX_SECONDS = 8;

  const resetState = useCallback(() => {
    setFile(null);
    setError(null);
    setResults(null);
    setExtractionLog([]);
    setIsRecording(false);
    if (videoRef.current) videoRef.current.src = "";
  }, []);

  const addLog = (message) => {
    setExtractionLog((prev) => [
      ...prev,
      `${new Date().toLocaleTimeString()}: ${message}`,
    ]);
  };

  // --- File Upload Logic ---
  const handleFileSelect = useCallback(
    (e) => {
      const selectedFile = e.target.files[0];
      if (selectedFile && selectedFile.type.startsWith("video/")) {
        resetState();
        setFile(selectedFile);

        // prepare hidden processing video src
        const videoURL = URL.createObjectURL(selectedFile);
        if (videoRef.current) {
          videoRef.current.src = videoURL;
        }

        // create preview object URL and cache it so render doesn't create a new one each time
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        previewUrlRef.current = videoURL;
        // force a light rerender to ensure UI picks up the new preview URL without recreating it repeatedly
        forceRerender((n) => n + 1);
      } else {
        setError("Please select a valid video file");
      }
    },
    [resetState]
  );

  // --- Webcam Logic ---
  const startCamera = useCallback(async () => {
    // Do not reset global UI state here; callers should do that before switching modes.
    try {
      console.debug("[startCamera] requesting media stream");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      console.debug("[startCamera] got stream", stream);
      streamRef.current = stream;

      // Wait for the webcam video element to be mounted and its ref to be populated.
      const waitForVideoRef = async (timeout = 2000) => {
        const start = Date.now();
        while (!webcamVideoRef.current && Date.now() - start < timeout) {
          // short delay
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 50));
        }
        return !!webcamVideoRef.current;
      };

      const videoReady = await waitForVideoRef(2000);
      if (!videoReady) {
        console.warn(
          "[startCamera] webcam video element not found within timeout"
        );
      }

      if (webcamVideoRef.current) {
        try {
          webcamVideoRef.current.srcObject = stream;
          console.debug(
            "[startCamera] assigned srcObject to video element",
            webcamVideoRef.current
          );

          const onLoaded = () =>
            console.debug("[webcam video] loadedmetadata event");
          const onPlaying = () => console.debug("[webcam video] playing event");
          const onError = (e) => console.error("[webcam video] error event", e);

          webcamVideoRef.current.addEventListener("loadedmetadata", onLoaded);
          webcamVideoRef.current.addEventListener("playing", onPlaying);
          webcamVideoRef.current.addEventListener("error", onError);

          // Try to play; if it fails with AbortError because the element was briefly removed,
          // retry once shortly after.
          const tryPlay = async () => {
            try {
              const playPromise = webcamVideoRef.current.play();
              if (playPromise && typeof playPromise.then === "function") {
                await playPromise;
              }
              console.debug("[startCamera] video.play() succeeded");
            } catch (err) {
              console.error("[startCamera] video.play() failed", err);
              // If AbortError, retry once after a brief delay
              if (err && err.name === "AbortError") {
                console.debug(
                  "[startCamera] retrying video.play() after AbortError"
                );
                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => setTimeout(r, 200));
                try {
                  await webcamVideoRef.current.play();
                  console.debug("[startCamera] video.play() retry succeeded");
                } catch (err2) {
                  console.error(
                    "[startCamera] video.play() retry failed",
                    err2
                  );
                }
              }
            }
          };

          tryPlay();
        } catch (err) {
          console.error(
            "[startCamera] error assigning stream to video element",
            err
          );
        }
      } else {
        console.warn(
          "[startCamera] webcamVideoRef.current is null after waiting"
        );
      }
      setIsCameraActive(true);
    } catch (err) {
      setError(
        "Failed to access camera. Please ensure permissions are granted."
      );
      console.error("Error accessing media devices.", err);
    }
  }, []);

  // Helper to attach a MediaStream to a video element with graceful retries and cleanup
  const attachStreamToElement = useCallback((el) => {
    if (!el) return;
    const stream = streamRef.current;
    if (!stream) return;

    // Remove previous listeners if any
    if (el.__attachedListeners) {
      try {
        el.removeEventListener(
          "loadedmetadata",
          el.__attachedListeners.onLoaded
        );
        el.removeEventListener("playing", el.__attachedListeners.onPlaying);
        el.removeEventListener("error", el.__attachedListeners.onError);
      } catch (e) {
        // ignore
      }
      el.__attachedListeners = null;
    }

    try {
      el.srcObject = stream;
      console.debug(
        "[attachStreamToElement] srcObject assigned to element",
        el
      );

      const onLoaded = () =>
        console.debug("[webcam video] loadedmetadata event (callback ref)");
      const onPlaying = () =>
        console.debug("[webcam video] playing event (callback ref)");
      const onError = (e) =>
        console.error("[webcam video] error event (callback ref)", e);

      el.addEventListener("loadedmetadata", onLoaded);
      el.addEventListener("playing", onPlaying);
      el.addEventListener("error", onError);

      el.__attachedListeners = { onLoaded, onPlaying, onError };

      const tryPlay = async () => {
        try {
          const playPromise = el.play();
          if (playPromise && typeof playPromise.then === "function") {
            await playPromise;
          }
          console.debug(
            "[attachStreamToElement] video.play() succeeded (callback ref)"
          );
        } catch (err) {
          console.error(
            "[attachStreamToElement] video.play() failed (callback ref)",
            err
          );
          if (err && err.name === "AbortError") {
            console.debug(
              "[attachStreamToElement] retrying video.play() after AbortError (callback ref)"
            );
            await new Promise((r) => setTimeout(r, 200));
            try {
              await el.play();
              console.debug(
                "[attachStreamToElement] video.play() retry succeeded (callback ref)"
              );
            } catch (err2) {
              console.error(
                "[attachStreamToElement] video.play() retry failed (callback ref)",
                err2
              );
            }
          }
        }
      };

      tryPlay();
    } catch (err) {
      console.error(
        "[attachStreamToElement] failed to attach stream to element",
        err
      );
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    setIsCameraActive(false);
  }, []);

  useEffect(() => {
    // When input mode changes, start or stop the camera accordingly.
    // This avoids a race where `startCamera` runs before the webcam video
    // element is mounted and its ref is available.
    if (inputMode === "record") {
      // Start camera when entering record mode
      (async () => {
        try {
          await startCamera();
          // Initialize MediaPipe for real-time extraction after camera is ready
          // eslint-disable-next-line react-hooks/exhaustive-deps
          await initializeRealtimeLandmarkExtraction();
        } catch (err) {
          // startCamera already handles setting the error state
        }
      })();
    } else {
      // Stop camera when leaving record mode
      stopCamera();
    }

    // Ensure camera is stopped on unmount
    return () => {
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputMode, stopCamera, startCamera]);

  // Manage preview object URL lifecycle: create when `file` changes, revoke on cleanup
  useEffect(() => {
    if (!file) {
      if (previewUrlRef.current) {
        try {
          URL.revokeObjectURL(previewUrlRef.current);
        } catch (e) {}
        previewUrlRef.current = null;
        forceRerender((n) => n + 1);
      }
      return;
    }

    if (!previewUrlRef.current) {
      try {
        previewUrlRef.current = URL.createObjectURL(file);
        // ensure the hidden processing video uses the same URL if not set
        if (videoRef.current) videoRef.current.src = previewUrlRef.current;
        forceRerender((n) => n + 1);
      } catch (e) {
        console.error("[preview] failed to create object URL", e);
      }
    }

    return () => {
      // revoke when file changes/unmount
      if (previewUrlRef.current) {
        try {
          URL.revokeObjectURL(previewUrlRef.current);
        } catch (e) {}
        previewUrlRef.current = null;
      }
    };
  }, [file]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      if (recordingTimeoutRef.current) {
        clearTimeout(recordingTimeoutRef.current);
        recordingTimeoutRef.current = null;
      }
      if (germanResultsCopyTimerRef.current) {
        clearTimeout(germanResultsCopyTimerRef.current);
        germanResultsCopyTimerRef.current = null;
      }
      if (translationFeatureCopyTimerRef.current) {
        clearTimeout(translationFeatureCopyTimerRef.current);
        translationFeatureCopyTimerRef.current = null;
      }
      if (historyCopyTimerRef.current) {
        clearTimeout(historyCopyTimerRef.current);
        historyCopyTimerRef.current = null;
      }
      if (landmarkExtractionIntervalRef.current) {
        clearInterval(landmarkExtractionIntervalRef.current);
        landmarkExtractionIntervalRef.current = null;
      }
      if (mediapipeHandsRef.current) {
        try {
          mediapipeHandsRef.current.close();
          mediapipeHandsRef.current = null;
        } catch (e) {
          console.warn("[cleanup] failed to close MediaPipe", e);
        }
      }
    };
  }, []);

  // Load translation history from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("translationHistory");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setTranslationHistory(parsed.slice(0, 10));
      }
    } catch (e) {
      console.warn("[history] failed to load translation history", e);
    }
  }, []);

  // Helpers for history UI
  const getConfidenceClass = (conf) => {
    if (conf >= 0.85) return "bg-green-100 text-green-800";
    if (conf >= 0.6) return "bg-yellow-100 text-yellow-800";
    return "bg-red-100 text-red-800";
  };

  const getConfidenceValue = (c) => {
    if (!c) return 0;
    if (typeof c === "number") return c;
    if (typeof c === "object") return c.overall ?? c.value ?? 0;
    return 0;
  };

  const clearHistory = () => {
    try {
      localStorage.removeItem("translationHistory");
    } catch (e) {
      console.warn("[history] failed to clear", e);
    }
    setTranslationHistory([]);
  };

  const deleteHistoryItem = (recordId) => {
    const updatedHistory = translationHistory.filter(rec => rec.id !== recordId);
    setTranslationHistory(updatedHistory);
    try {
      localStorage.setItem("translationHistory", JSON.stringify(updatedHistory));
    } catch (e) {
      console.warn("[history] failed to update after delete", e);
    }
  };

  // Text-to-speech helpers with section-specific state
  const speakTranslation = useCallback((text, lang = "de-DE", section = "german", recordId = null) => {
    if (!text || typeof window === "undefined" || !window.speechSynthesis)
      return;
    try {
      // Stop any existing speech
      window.speechSynthesis.cancel();
      
      // Check if already speaking in this section
      const isSpeakingInSection = 
        (section === "german" && germanResultsSpeaking) ||
        (section === "translation" && translationFeatureSpeaking) ||
        (section === "history" && historySpeakingId === recordId);
      
      if (isSpeakingInSection) {
        stopSpeaking(section, recordId);
        return;
      }

      // Convert language code to speech synthesis tag if needed (e.g., 'en' -> 'en-US')
      let langTag = lang;
      const langMap = {
        'en': 'en-US',
        'es': 'es-ES',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'it': 'it-IT',
        'pt': 'pt-PT',
        'nl': 'nl-NL',
        'pl': 'pl-PL',
        'ru': 'ru-RU',
        'ja': 'ja-JP',
        'zh': 'zh-CN',
        'ar': 'ar-SA',
        'hi': 'hi-IN',
        'ms': 'id-ID',
        'fil': 'id-ID',
      };
      langTag = langMap[lang] || lang;

      utteranceRef.current = new SpeechSynthesisUtterance(text);
      utteranceRef.current.lang = langTag;
      utteranceRef.current.rate = 1.0;
      
      // Try to pick a voice for the target language
      const voices = window.speechSynthesis.getVoices
        ? window.speechSynthesis.getVoices()
        : [];
      if (voices && voices.length) {
        const targetVoice = voices.find(
          (v) => v.lang.startsWith(langTag.split('-')[0])
        );
        if (targetVoice) utteranceRef.current.voice = targetVoice;
      }

      utteranceRef.current.onstart = () => {
        if (section === "german") setGermanResultsSpeaking(true);
        else if (section === "translation") setTranslationFeatureSpeaking(true);
        else if (section === "history" && recordId) setHistorySpeakingId(recordId);
      };
      
      utteranceRef.current.onend = () => {
        if (section === "german") setGermanResultsSpeaking(false);
        else if (section === "translation") setTranslationFeatureSpeaking(false);
        else if (section === "history") setHistorySpeakingId(null);
      };
      
      utteranceRef.current.onerror = () => {
        if (section === "german") setGermanResultsSpeaking(false);
        else if (section === "translation") setTranslationFeatureSpeaking(false);
        else if (section === "history") setHistorySpeakingId(null);
      };
      
      window.speechSynthesis.speak(utteranceRef.current);
    } catch (e) {
      console.warn("[tts] speak failed", e);
    }
  }, [germanResultsSpeaking, translationFeatureSpeaking, historySpeakingId]);

  const stopSpeaking = (section = "german", recordId = null) => {
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {
      console.warn("[tts] stop failed", e);
    } finally {
      if (section === "german") setGermanResultsSpeaking(false);
      else if (section === "translation") setTranslationFeatureSpeaking(false);
      else if (section === "history") setHistorySpeakingId(null);
      utteranceRef.current = null;
    }
  };

  // Copy-to-clipboard helpers with section-specific state
  const copyToClipboard = useCallback(async (text, section = "german", recordId = null) => {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      
      let timerRef, setCopiedFn;
      if (section === "german") {
        setCopiedFn = setGermanResultsCopiedId;
        timerRef = germanResultsCopyTimerRef;
      } else if (section === "translation") {
        setCopiedFn = setTranslationFeatureCopiedId;
        timerRef = translationFeatureCopyTimerRef;
      } else if (section === "history") {
        setCopiedFn = setHistoryCopiedId;
        timerRef = historyCopyTimerRef;
      }
      
      // For german and translation: set to true, for history: set to recordId
      if (section === "history") {
        setCopiedFn(recordId);
      } else {
        setCopiedFn(true);
      }
      
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedFn(section === "history" ? null : false), 2000);
    } catch (e) {
      console.warn("[copy] failed", e);
    }
  }, []);

  const TranslationFeature = React.memo(({ germanText }) => {
    const languages = [
      { code: 'en', name: 'English', flag: '🇬🇧' },
      { code: 'ms', name: 'Bahasa Malaysia', flag: '🇲🇾' },
      { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
      { code: 'fil', name: 'Filipino', flag: '🇵🇭' },
      { code: 'es', name: 'Spanish', flag: '🇪🇸' },
      { code: 'fr', name: 'French', flag: '🇫🇷' },
      { code: 'it', name: 'Italian', flag: '🇮🇹' },
      { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
      { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
      { code: 'pl', name: 'Polish', flag: '🇵🇱' },
      { code: 'ru', name: 'Russian', flag: '🇷🇺' },
      { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
      { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
      { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
    ];

    // MyMemory API
    const translateWithMyMemory = async (text, target) => {
      const response = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=de|${target}`
      );
      const data = await response.json();
      if (data.responseStatus !== 200) {
        throw new Error('Translation service unavailable');
      }
      return data.responseData.translatedText;
    };

    const translateGermanResults = async () => {
      if (!germanText) return;
      
      setTranslationFeatureState(prev => ({ ...prev, isTranslating: true, error: null }));
      
      try {
        let translated;
        
        try {
          translated = await translateWithMyMemory(germanText, translationFeatureState.targetLang);
        } catch (e) {
          console.warn('MyMemory failed, trying Google:', e);
        }
        setTranslationFeatureState(prev => ({ ...prev, translatedText: translated }));
      } catch (err) {
        setTranslationFeatureState(prev => ({ ...prev, error: 'Translation failed. Please try again.' }));
        console.error('All translation services failed:', err);
      } finally {
        setTranslationFeatureState(prev => ({ ...prev, isTranslating: false }));
      }
    };

    return (
      <div className="mt-4 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-indigo-200">
        <h3 className="text-sm font-semibold text-indigo-700 mb-3 flex items-center">
          <Globe className="mr-2" size={18} />
          {t('translateTo')}
        </h3>
        
        <div className="flex items-center gap-3 mb-3">
          <select
            value={translationFeatureState.targetLang}
            onChange={(e) => {
              setTranslationFeatureState(prev => ({ ...prev, targetLang: e.target.value, translatedText: '' }));
            }}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            {languages.map(lang => (
              <option key={lang.code} value={lang.code}>
                {lang.flag} {lang.name}
              </option>
            ))}
          </select>
          
          <button
            onClick={translateGermanResults}
            disabled={translationFeatureState.isTranslating || !germanText}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center"
          >
            {translationFeatureState.isTranslating ? (
              <>
                <Loader2 className="mr-2 animate-spin" size={16} />
                {t('translating')}
              </>
            ) : (
              t('translateButton')
            )}
          </button>
        </div>
        
        {translationFeatureState.error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
            {translationFeatureState.error}
          </div>
        )}
        
        {translationFeatureState.translatedText && (
          <div className="p-3 bg-white rounded-lg border border-indigo-200">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <p className="text-gray-800">{translationFeatureState.translatedText}</p>
                <p className="text-xs text-gray-500 mt-2">
                  {t('translatedFrom')} {languages.find(l => l.code === translationFeatureState.targetLang)?.name}
                </p>
              </div>
              <div className="flex-shrink-0 ml-2 flex items-center space-x-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    speakTranslation(translationFeatureState.translatedText, translationFeatureState.targetLang, "translation");
                  }}
                  className={`px-2 py-1 rounded-md text-sm ${
                    translationFeatureSpeaking
                      ? "bg-gray-200 text-gray-700"
                      : "bg-indigo-600 text-white hover:bg-indigo-700"
                  }`}
                  title={t("playTranslation")}
                >
                  {translationFeatureSpeaking ? "⏹" : "🔊"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    copyToClipboard(translationFeatureState.translatedText, "translation");
                  }}
                  disabled={!translationFeatureState.translatedText}
                  className={`px-3 py-1 rounded-md text-sm ${
                    translationFeatureCopiedId
                      ? "bg-green-600 text-white"
                      : "bg-gray-200 text-gray-700"
                  } hover:bg-gray-300 disabled:opacity-50`}
                  title={
                    translationFeatureCopiedId ? t("copied") : t("copy")
                  }
                >
                  {translationFeatureCopiedId ? t("copied") : t("copy")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }, (prevProps, nextProps) => prevProps.germanText === nextProps.germanText);

  // Initialize MediaPipe for real-time landmark extraction
  const initializeRealtimeLandmarkExtraction = useCallback(async () => {
    if (mediapipeHandsRef.current) return; // Already initialized

    try {
      const hands = new window.Hands({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });

      hands.onResults((results) => {
        const frameLandmarks = extractTwoHandLandmarks(results);
        realtimeLandmarksRef.current.push(frameLandmarks);
      });

      await hands.initialize();
      mediapipeHandsRef.current = hands;
      console.debug("[realtime] MediaPipe Hands initialized");
    } catch (err) {
      console.error("[realtime] Failed to initialize MediaPipe", err);
    }
  }, []);

  // Start real-time landmark extraction during recording
  const startRealtimeLandmarkExtraction = useCallback(() => {
    if (!mediapipeHandsRef.current || !webcamVideoRef.current || !canvasRef.current) {
      console.warn("[realtime] Prerequisites not met for landmark extraction");
      return;
    }

    realtimeLandmarksRef.current = []; // Reset landmarks array
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const IMG_SIZE = CONFIG.IMG_SIZE;
    const TARGET_FPS = CONFIG.TARGET_FPS;
    canvas.width = IMG_SIZE[0];
    canvas.height = IMG_SIZE[1];

    // Extract frames at target FPS
    const frameInterval = 1000 / TARGET_FPS; // milliseconds
    landmarkExtractionIntervalRef.current = setInterval(async () => {
      if (webcamVideoRef.current && webcamVideoRef.current.readyState === 4) {
        ctx.drawImage(webcamVideoRef.current, 0, 0, canvas.width, canvas.height);
        await mediapipeHandsRef.current.send({ image: canvas });
      }
    }, frameInterval);

    console.debug("[realtime] Started landmark extraction");
  }, [CONFIG.IMG_SIZE, CONFIG.TARGET_FPS]);

  // Stop real-time landmark extraction
  const stopRealtimeLandmarkExtraction = useCallback(() => {
    if (landmarkExtractionIntervalRef.current) {
      clearInterval(landmarkExtractionIntervalRef.current);
      landmarkExtractionIntervalRef.current = null;
      console.debug("[realtime] Stopped landmark extraction, collected", realtimeLandmarksRef.current.length, "frames");
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!streamRef.current) {
      setError("Camera not active.");
      return;
    }
    // Use an internal chunks buffer on the MediaRecorder instance to avoid relying on React state updates inside the dataavailable handler.
    try {
      mediaRecorderRef.current = new MediaRecorder(streamRef.current);
    } catch (err) {
      console.error("[startRecording] Failed to create MediaRecorder", err);
      setError("Recording not supported in this browser or with these codecs");
      return;
    }

    mediaRecorderRef.current._chunks = [];

    mediaRecorderRef.current.ondataavailable = (event) => {
      try {
        if (event.data && event.data.size > 0) {
          console.debug("[mediaRecorder] dataavailable size", event.data.size);
          mediaRecorderRef.current._chunks.push(event.data);
        } else {
          console.debug(
            "[mediaRecorder] dataavailable empty or zero-size chunk"
          );
        }
      } catch (err) {
        console.error("[mediaRecorder] ondataavailable handler error", err);
      }
    };

    mediaRecorderRef.current.onerror = (e) => {
      console.error("[mediaRecorder] error", e);
    };

    mediaRecorderRef.current.onstop = () => {
      try {
        const chunks = mediaRecorderRef.current._chunks || [];
        console.debug(
          "[mediaRecorder] onstop, chunks count",
          chunks.length,
          "sizes",
          chunks.map((c) => c.size)
        );
        const blobType = chunks.length
          ? chunks[0].type || "video/webm"
          : "video/webm";
        const blob = new Blob(chunks, { type: blobType });
        const recordedFile = new File([blob], `recording-${Date.now()}.webm`, {
          type: blob.type,
        });
        setFile(recordedFile); // Set the recorded blob as the file for translation

        // Stop real-time landmark extraction
        stopRealtimeLandmarkExtraction();

        // Update the hidden video element for landmark extraction
        const videoURL = URL.createObjectURL(blob);
        if (videoRef.current) {
          videoRef.current.src = videoURL;
        }
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        previewUrlRef.current = videoURL;
        forceRerender((n) => n + 1);
      } catch (err) {
        console.error("[mediaRecorder] onstop handler error", err);
      }
    };

    try {
      mediaRecorderRef.current.start();
      console.debug(
        "[startRecording] mediaRecorder started",
        mediaRecorderRef.current.state
      );
      setIsRecording(true);

      // Start real-time landmark extraction
      startRealtimeLandmarkExtraction();

      // Start countdown and auto-stop timer
      const maxSeconds = DEFAULT_RECORD_MAX_SECONDS;
      setRemainingSeconds(maxSeconds);

      // Clear any existing timers
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      if (recordingTimeoutRef.current) {
        clearTimeout(recordingTimeoutRef.current);
        recordingTimeoutRef.current = null;
      }

      countdownTimerRef.current = setInterval(() => {
        setRemainingSeconds((s) => (s > 0 ? s - 1 : 0));
      }, 1000);

      recordingTimeoutRef.current = setTimeout(() => {
        try {
          if (
            mediaRecorderRef.current &&
            mediaRecorderRef.current.state !== "inactive"
          ) {
            if (stopRecordingRef.current) stopRecordingRef.current();
          }
        } catch (e) {
          console.error("[recordingTimeout] stopRecording failed", e);
        }
      }, maxSeconds * 1000);
    } catch (err) {
      console.error("[startRecording] start() failed", err);
      setError("Failed to start recording");
    }
  }, [startRealtimeLandmarkExtraction, stopRealtimeLandmarkExtraction]);

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.error("[stopRecording] failed to stop mediaRecorder", err);
      }
    } else {
      console.debug("[stopRecording] no active mediaRecorder to stop");
    }
    setIsRecording(false);

    // Clear countdown and timeout
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    setRemainingSeconds(0);
  }, []);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  // --- Landmark Extraction Logic (unchanged from original) ---
  const extractTwoHandLandmarks = (handsResults) => {
    let leftHand = new Array(21).fill(null).map(() => [0, 0, 0]);
    let rightHand = new Array(21).fill(null).map(() => [0, 0, 0]);

    if (handsResults.multiHandLandmarks && handsResults.multiHandedness) {
      for (let i = 0; i < handsResults.multiHandLandmarks.length; i++) {
        const handLandmarks = handsResults.multiHandLandmarks[i];
        const handLabel = handsResults.multiHandedness[i].label;

        const landmarkArray = handLandmarks.map((lm) => [lm.x, lm.y, lm.z]);

        // Note: MediaPipe's 'Left' and 'Right' labels are relative to the camera,
        // so 'Right' hand in the frame is the user's left hand. This logic maintains
        // a consistent structure for the model input (LeftHandLandmarks, RightHandLandmarks).
        if (handLabel === "Left") {
          leftHand = landmarkArray;
        } else if (handLabel === "Right") {
          rightHand = landmarkArray;
        }
      }
    }

    // Concatenate [Left Hand (21*3), Right Hand (21*3)]
    return [...leftHand, ...rightHand];
  };

  const extractLandmarksFromVideo = async (onProgressUpdate, onLogUpdate) => {
    return new Promise(async (resolve, reject) => {
      try {
        const localLogs = [];
        const addLocalLog = (message) => {
          const logMessage = `${new Date().toLocaleTimeString()}: ${message}`;
          localLogs.push(logMessage);
          // Update state immediately if callback provided
          if (onLogUpdate) {
            onLogUpdate(logMessage);
          }
        };

        addLocalLog(t("log_initializing_mediapipe"));

        // Load MediaPipe Hands
        const hands = new window.Hands({
          locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });

        hands.setOptions({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });

        const landmarksList = [];
        let processedFrames = 0;
        let totalFrames = 0;
        let lastProgressUpdate = 0;

        hands.onResults((results) => {
          const frameLandmarks = extractTwoHandLandmarks(results);
          landmarksList.push(frameLandmarks);
          processedFrames++;

          // Update progress only every 5% increment to reduce re-renders
          if (totalFrames > 0) {
            const extractionProgress = (processedFrames / totalFrames) * 50;
            const roundedProgress = Math.floor(extractionProgress / 5) * 5; // Round to nearest 5%
            
            if (roundedProgress > lastProgressUpdate && onProgressUpdate) {
              lastProgressUpdate = roundedProgress;
              onProgressUpdate(Math.min(roundedProgress, 50));
            }
          }

          // Add log every 25 frames but don't trigger state update
          if (processedFrames % 25 === 0) {
            addLocalLog(t("log_processed_frames", processedFrames, totalFrames));
          }
        });

        await hands.initialize();
        addLocalLog(t("log_mediapipe_initialized"));

        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");

        // Ensure video metadata is loaded
        await new Promise((resolveMeta) => {
          if (video.readyState >= 2) resolveMeta();
          else video.onloadedmetadata = resolveMeta;
        });
        video.currentTime = 0;

        const duration = video.duration;
        const fps = CONFIG.TARGET_FPS;
        const frameInterval = 1 / fps;
        totalFrames = Math.max(0, Math.floor(duration * fps));

        addLocalLog(t("log_video_duration", duration.toFixed(2)));
        addLocalLog(t("log_extract_frames", totalFrames, fps));

        canvas.width = CONFIG.IMG_SIZE[0];
        canvas.height = CONFIG.IMG_SIZE[1];

        // Process frames
        for (let i = 0; i < totalFrames; i++) {
          const timestamp = i * frameInterval;
          await new Promise((resolveFrame) => {
            video.currentTime = timestamp;
            video.onseeked = resolveFrame;
          });

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          await hands.send({ image: canvas });
        }

        hands.close();

        addLocalLog(t("log_extracted_frames", landmarksList.length));

        const uniformTruncate = (sequence, targetLen) => {
          const N = sequence.length;
          if (N <= targetLen) return sequence.slice();
          if (targetLen <= 0) return [];
          const out = [];
          for (let i = 0; i < targetLen; i++) {
            const idx = Math.floor((i * (N - 1)) / Math.max(targetLen - 1, 1));
            out.push(sequence[idx]);
          }
          return out;
        };

        if (landmarksList.length > CONFIG.MAX_SEQ_LEN) {
          addLocalLog(
            t("log_truncating", landmarksList.length, CONFIG.MAX_SEQ_LEN)
          );
          const truncated = uniformTruncate(landmarksList, CONFIG.MAX_SEQ_LEN);
          landmarksList.length = 0;
          landmarksList.push(...truncated);
        } else if (landmarksList.length < CONFIG.MAX_SEQ_LEN) {
          const padLen = CONFIG.MAX_SEQ_LEN - landmarksList.length;
          addLocalLog(
            t("log_padding", landmarksList.length, CONFIG.MAX_SEQ_LEN, padLen)
          );
          for (let p = 0; p < padLen; p++) {
            const padFrame = Array.from({ length: 42 }, () => [-10, -10, -10]);
            landmarksList.push(padFrame);
          }
        }

        addLocalLog(t("log_final_sequence", landmarksList.length));

        const flatLandmarks = landmarksList.map((frame) => frame.flat());
        addLocalLog(t("log_landmark_extraction_complete"));

        resolve({ flatLandmarks, logs: localLogs });
      } catch (err) {
        const errMsg = err && err.message ? err.message : String(err);
        reject(new Error(errMsg));
      }
    });
  };

  // --- Main Translation Handler ---
  const handleTranslate = async () => {
    if (!file) {
      setError(
        inputMode === "upload"
          ? "Please select a video file first"
          : "Please record a video first"
      );
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    setError(null);
    setResults(null);
    setExtractionLog([]);
    if (isCameraActive) stopCamera();

    try {
      // Stage 1: Extract landmarks in frontend
      setCurrentStage(t("extractingLandmarks"));
      setExtractionLog([`${new Date().toLocaleTimeString()}: ${t("log_starting_landmark_extraction")}`]);

      let extractedLandmarks = [];

      // Check if we have real-time landmarks from recording
      if (inputMode === "record" && realtimeLandmarksRef.current.length > 0) {
        const originalFrameCount = realtimeLandmarksRef.current.length;
        console.debug("[translate] Using real-time landmarks:", originalFrameCount, "frames");
        setExtractionLog(prev => [...prev, `${new Date().toLocaleTimeString()}: Using real-time extracted landmarks (${originalFrameCount} frames)`]);
        
        let landmarksList = realtimeLandmarksRef.current;
        
        // Process landmarks (truncate or pad as needed)
        const uniformTruncate = (sequence, targetLen) => {
          const N = sequence.length;
          if (N <= targetLen) return sequence.slice();
          if (targetLen <= 0) return [];
          const out = [];
          for (let i = 0; i < targetLen; i++) {
            const idx = Math.floor((i * (N - 1)) / Math.max(targetLen - 1, 1));
            out.push(sequence[idx]);
          }
          return out;
        };

        if (landmarksList.length > CONFIG.MAX_SEQ_LEN) {
          setExtractionLog(prev => [...prev, `${new Date().toLocaleTimeString()}: Truncating from ${originalFrameCount} frames to ${CONFIG.MAX_SEQ_LEN} frames`]);
          landmarksList = uniformTruncate(landmarksList, CONFIG.MAX_SEQ_LEN);
        } else if (landmarksList.length < CONFIG.MAX_SEQ_LEN) {
          const padLen = CONFIG.MAX_SEQ_LEN - landmarksList.length;
          setExtractionLog(prev => [...prev, `${new Date().toLocaleTimeString()}: Padding from ${originalFrameCount} frames to ${CONFIG.MAX_SEQ_LEN} frames (added ${padLen} padding frames)`]);
          for (let p = 0; p < padLen; p++) {
            const padFrame = Array.from({ length: 42 }, () => [-10, -10, -10]);
            landmarksList.push(padFrame);
          }
        } else {
          setExtractionLog(prev => [...prev, `${new Date().toLocaleTimeString()}: Using exactly ${originalFrameCount} frames (no padding or truncation needed)`]);
        }

        extractedLandmarks = landmarksList.map((frame) => frame.flat());
        setProgress(50);
      } else {
        // Fallback to video-based extraction for uploaded videos
        const extractionResult = await extractLandmarksFromVideo(
          (progress) => {
            setProgress(progress);
          },
          (log) => {
            setExtractionLog((prev) => [...prev, log]);
          }
        );
        
        extractedLandmarks = extractionResult.flatLandmarks || [];
        setProgress(50);
      }

      // Stage 2: Send to backend for translation
      setCurrentStage(t("translatingSignLanguage"));
      setExtractionLog(prev => [...prev, `${new Date().toLocaleTimeString()}: ${t("log_sending_landmarks")}`]);

      const response = await fetch(CONFIG.BACKEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          landmarks: extractedLandmarks,
          method: "reranked_s2g_beam_g2t",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const errorData = JSON.parse(errorText);
          throw new Error(errorData.error || "Translation failed");
        } catch {
          throw new Error(`Server error: ${errorText.substring(0, 100)}...`);
        }
      }

      const data = await response.json();
      setProgress(100);

      setResults({
        gloss: data.gloss,
        translation: data.translation,
        confidence: data.confidence.overall,
        method: translationMethods[selectedMethod],
        processingTime: data.timing?.total || "N/A",
        landmarksShape: data.landmarks_shape,
      });

      // Reset translation feature state for new results
      setTranslationFeatureState({
        targetLang: 'en',
        translatedText: '',
        isTranslating: false,
        error: null,
      });

      try {
        speakTranslation(data.translation, "de-DE", "results");
      } catch (e) {
        console.warn("[handleTranslate] auto-speak failed", e);
      }

      // Append to translation history (keep latest 10)
      try {
        const record = {
          id: Date.now(),
          time: new Date().toLocaleString(),
          translation: data.translation,
          confidence: data.confidence || 0,
          method: "reranked_s2g_beam_g2t",
        };
        setTranslationHistory((prev) => {
          const next = [record, ...prev].slice(0, 10);
          try {
            localStorage.setItem("translationHistory", JSON.stringify(next));
          } catch (e) {
            console.warn("[history] save failed", e);
          }
          return next;
        });
      } catch (e) {
        console.warn("[history] append failed", e);
      }

      setExtractionLog(prev => [...prev, `${new Date().toLocaleTimeString()}: ${t("log_translation_complete")}`]);
    } catch (err) {
      setError(err.message || t("translationFailedTryAgain"));
      setExtractionLog(prev => [...prev, `${new Date().toLocaleTimeString()}: ${t("log_error_prefix", err.message)}`]);
      console.error(err);
    } finally {
      setIsProcessing(false);
      setCurrentStage("");
      if (inputMode === "record") {
        try {
          await startCamera();
        } catch (e) {
          console.warn("[handleTranslate] failed to restart camera", e);
        }
      }
    }
  };

  const handleTranslateRef = useRef();
  handleTranslateRef.current = handleTranslate;
  const stableHandleTranslate = useCallback(() => {
    if (handleTranslateRef.current) handleTranslateRef.current();
  }, []);

  // --- External Script Loading ---
  useEffect(() => {
    // Load MediaPipe scripts dynamically to ensure they are available globally
    const scripts = [
      "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js",
      "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js",
      "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js",
    ];

    const scriptElements = scripts.map((src) => {
      const script = document.createElement("script");
      script.src = src;
      script.crossOrigin = "anonymous";
      document.body.appendChild(script);
      return script;
    });

    return () => {
      scriptElements.forEach((script) => document.body.removeChild(script));
    };
  }, []);

  // --- UI Components ---
  const InputModeSelector = React.memo(
    ({ inputModeProp, setInputModeProp, resetStateProp, stopCameraProp, isProcessingProp }) => (
      <div className="flex bg-gray-200 rounded-lg p-1 mb-6 shadow-inner">
        <button
          onClick={() => {
            if (isProcessingProp) return;
            resetStateProp();
            stopCameraProp();
            setInputModeProp("upload");
          }}
          disabled={isProcessingProp}
          title={isProcessingProp ? t("disabledDuringProcessing") : t("uploadButton")}
          className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors flex items-center justify-center ${
            inputModeProp === "upload"
              ? "bg-indigo-600 text-white shadow-md"
              : isProcessingProp
              ? "text-gray-400 cursor-not-allowed"
              : "text-gray-700 hover:bg-gray-300"
          }`}
        >
          <Upload className="w-5 h-5 mr-2" />
          {t("uploadButton")}
        </button>
        <button
          onClick={() => {
            if (isProcessingProp) return;
            resetStateProp();
            setInputModeProp("record");
          }}
          disabled={isProcessingProp}
          title={isProcessingProp ? t("disabledDuringProcessing") : t("recordButton")}
          className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors flex items-center justify-center ${
            inputModeProp === "record"
              ? "bg-indigo-600 text-white shadow-md"
              : isProcessingProp
              ? "text-gray-400 cursor-not-allowed"
              : "text-gray-700 hover:bg-gray-300"
          }`}
        >
          <Camera className="w-5 h-5 mr-2" />
          {t("recordButton")}
        </button>
      </div>
    )
  );

  const UploadInput = React.memo(
    ({ fileProp, fileInputRefProp, handleFileSelectProp, isProcessingProp }) => (
      <div className="">
        <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
          <Upload className="mr-2" size={24} />
          {t("step1UploadTitle")}
        </h2>

        <div
          onClick={() => {
            if (isProcessingProp) return;
            fileInputRefProp.current?.click();
          }}
          role="button"
          aria-disabled={isProcessingProp}
          title={isProcessingProp ? t("disabledDuringProcessing") : t("clickToSelect")}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isProcessingProp
              ? "border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed"
              : "border-gray-300 hover:border-indigo-500 cursor-pointer"
          }`}
        >
          {!fileProp ? (
            <div>
              <Video className="mx-auto mb-4 text-gray-400" size={48} />
              <p className="text-gray-600 mb-2">{t("clickToSelect")}</p>
              <p className="text-sm text-gray-400">{t("supportedFormats")}</p>
            </div>
          ) : (
            <div>
              <CheckCircle2 className="mx-auto mb-2 text-green-500" size={48} />
              <p className="text-gray-800 font-medium">{fileProp.name}</p>
              <p className="text-sm text-gray-500 mt-1">
                {(fileProp.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            </div>
          )}
        </div>

        <input
          ref={fileInputRefProp}
          type="file"
          accept="video/*"
          onChange={handleFileSelectProp}
          className="hidden"
        />
      </div>
    )
  );

  const WebcamRecorder = React.memo(
    ({
      isCameraActiveProp,
      isRecordingProp,
      isProcessingProp,
      webcamVideoRefProp,
      attachStreamToElementProp,
      startRecordingProp,
      stopRecordingProp,
      remainingSecondsProp,
      fileProp,
    }) => (
      <div className="">
        <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
          <Camera className="mr-2" size={24} />
          {t("recordStepTitle")}
        </h2>

        <div className="aspect-video bg-gray-800 rounded-lg overflow-hidden relative">
          {!isCameraActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white bg-gray-900/90 p-4">
              <Camera className="w-12 h-12 mb-4" />
              <p>
                {isProcessingProp
                  ? t("waitingForTranslation")
                  : t("loadingCamera")}
              </p>
            </div>
          )}
          <video
            ref={(el) => {
              webcamVideoRefProp.current = el;
              if (el && streamRef.current) {
                attachStreamToElementProp(el);
              }
            }}
            className={`w-full h-full object-cover ${
              isRecordingProp ? "border-4 border-red-500" : ""
            }`}
            style={{ transform: 'scaleX(-1)' }}
            autoPlay
            muted
            playsInline
          />
          {isRecordingProp && (
            <div className="absolute top-2 left-2 flex items-center bg-red-600 text-white text-sm px-2 py-1 rounded-full">
              <Circle className="w-3 h-3 fill-white mr-2 animate-pulse" />
              <span className="font-semibold">
                {remainingSecondsProp > 0 ? `${remainingSecondsProp}s` : "REC"}
              </span>
            </div>
          )}
          {fileProp && (
            <div
              className="absolute top-2 right-2 bg-green-600 text-white text-xs px-2 py-1 rounded-md flex items-center space-x-1 shadow"
              title={t("recordedReady")}
            >
              <CheckCircle2 className="w-3 h-3" />
              <span className="font-semibold">
                {(fileProp.size / (1024 * 1024)).toFixed(2)}MB
              </span>
            </div>
          )}
        </div>

        <div className="flex justify-center mt-4 space-x-4">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            // Disabled while translating, or when camera isn't active and not currently recording
            disabled={isProcessing || (!isCameraActive && !isRecording)}
            className={`p-3 rounded-full shadow-lg transition-all duration-200 
            ${
              isRecording
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-green-500 text-white hover:bg-green-600"
            } disabled:bg-gray-400`}
            title={isRecording ? t('stopRecording') : t('startRecording')}
          >
            {isRecordingProp ? (
              <StopCircle size={28} />
            ) : (
              <Circle size={28} fill="currentColor" />
            )}
          </button>
        </div>

        {/* compact badge shown inside the video card; no larger block here */}
      </div>
    )
  );

  const VideoPreview = React.memo(({ fileProp, previewUrlProp }) => {
    // Use a stable key based on the file to prevent video element recreation
    const videoKey = fileProp ? `video-${fileProp.name}-${fileProp.size}` : 'no-video';
    
    return (
      <div className="mt-4 bg-white rounded-lg shadow-lg p-6">
        <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
          <Video className="mr-2" size={24} />
          {t("videoPreviewTitle")}
        </h2>
        {fileProp ? (
          <video
            key={videoKey} // Stable key prevents recreation
            src={previewUrlProp}
            controls
            className="w-full rounded-lg"
            style={{ maxHeight: "300px" }}
          />
        ) : (
          <div className="h-48 w-full rounded-lg bg-gray-100 flex items-center justify-center text-gray-500">
            {t("noVideoUploaded")}
          </div>
        )}
      </div>
    );
  }, (prevProps, nextProps) => {
    // Custom comparison: only re-render if file actually changed
    return prevProps.fileProp === nextProps.fileProp && 
          prevProps.previewUrlProp === nextProps.previewUrlProp;
  });

  const LanguageSelector = React.memo(({ langProp, setLangProp }) => (
    <div className="ml-4">
      <span className="mr-2">🌐</span>
      <select
        value={langProp}
        onChange={(e) => setLangProp(e.target.value)}
        className="border rounded px-2 py-1 bg-white"
        aria-label="Language selector"
      >
        <option value="en">EN</option>
        <option value="de">DE</option>
      </select>
    </div>
  ));

  // Left column will be rendered inline in the main return to keep structure simple

  // --- Main Render ---

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pt-4">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">
            {t("title")}
          </h1>
          <LanguageSelector langProp={lang} setLangProp={setLang} />
        </div>
        <div className="mb-4 p-2 bg-yellow-50 rounded-lg">
          <p className="text-sm text-brown-800">
            <strong>{t("scopeTitle")}:</strong> {t("scopeText")}
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-6">
          {/* Input Card */}
          <div className="space-y-6" id="left-column">
            <InputModeSelector
              inputModeProp={inputMode}
              setInputModeProp={setInputMode}
              resetStateProp={resetState}
              stopCameraProp={stopCamera}
              isProcessingProp={isProcessing}
            />
            <div className="bg-white rounded-lg shadow-lg p-6">
              {inputMode === "upload" ? (
                <UploadInput
                  fileProp={file}
                  fileInputRefProp={fileInputRef}
                  handleFileSelectProp={handleFileSelect}
                  isProcessingProp={isProcessing}
                />
              ) : (
                <WebcamRecorder
                  isCameraActiveProp={isCameraActive}
                  isRecordingProp={isRecording}
                  isProcessingProp={isProcessing}
                  webcamVideoRefProp={webcamVideoRef}
                  attachStreamToElementProp={attachStreamToElement}
                  startRecordingProp={startRecording}
                  stopRecordingProp={stopRecording}
                  remainingSecondsProp={remainingSeconds}
                  fileProp={file}
                />
              )}
              <button
                onClick={stableHandleTranslate}
                disabled={!file || isProcessing}
                className="w-full mt-6 bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center shadow-md"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 animate-spin" size={20} />
                    {currentStage || t("processing")}
                  </>
                ) : (
                  t("step3Translate")
                )}
              </button>
            </div>

            <VideoPreview
              fileProp={file}
              previewUrlProp={previewUrlRef.current}
            />

            {/* <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
                <Settings className="mr-2" size={24} />
                {t("advancedTranslationMethod")}
              </h2>

              <div className="space-y-2">
                {Object.entries(translationMethods).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center p-3 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors"
                  >
                    <input
                      type="radio"
                      name="method"
                      value={key}
                      checked={selectedMethod === key}
                      onChange={(e) => setSelectedMethod(e.target.value)}
                      className="mr-3 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-gray-700">{label}</span>
                  </label>
                ))}
              </div>
            </div> */}
          </div>

          {/* Results Card */}
          <div className="space-y-6">
            {/* Processing Status */}
            {isProcessing && (
              <div className="bg-white rounded-lg shadow-lg p-6">
                <h2 className="text-xl font-semibold text-gray-800 mb-4">
                  {t("processingStatus")}
                </h2>

                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-sm text-gray-600 mb-2">
                      <span>{currentStage}</span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-3">
                      <div
                        className="bg-indigo-600 h-3 rounded-full transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  {/* Extraction Log */}
                  <div className="mt-4 bg-gray-50 rounded p-3 max-h-40 overflow-y-auto">
                    <p className="text-xs font-semibold text-gray-600 mb-2">
                      {t("processingLog")}
                    </p>
                    {extractionLog.map((log, idx) => (
                      <p key={idx} className="text-xs text-gray-600 font-mono">
                        {log}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start">
                <AlertCircle
                  className="text-red-500 mr-3 flex-shrink-0"
                  size={24}
                />
                <div>
                  <h3 className="font-semibold text-red-800">
                    {t("errorTitle")}
                  </h3>
                  <p className="text-red-600 text-sm mt-1">{error}</p>
                </div>
              </div>
            )}

            {/* Results Display */}
            {results && (
              <div className="bg-white rounded-lg shadow-lg p-6">
                <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
                  <FileText className="mr-2" size={24} />
                  {t("translationResults")}
                </h2>

                <div className="space-y-4">
                  {/* Gloss Sequence */}
                  <div className="bg-gray-50 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-gray-600 mb-2">
                      {t("glossSequence")}
                    </h3>
                    <p className="text-gray-800 font-mono text-sm">
                      {results.gloss}
                    </p>
                  </div>

                  {/* German Translation */}
                  <div className="bg-indigo-50 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-indigo-600 mb-2">
                      {t("germanTranslation")}
                    </h3>
                    <div className="flex items-start justify-between">
                      <p className="text-gray-800 text-lg mr-4">
                        {results.translation}
                      </p>
                      <div className="flex-shrink-0 ml-2 flex items-center space-x-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            speakTranslation(results.translation, "de-DE", "german");
                          }}
                          className={`px-2 py-1 rounded-md text-sm ${
                            germanResultsSpeaking
                              ? "bg-gray-200 text-gray-700"
                              : "bg-indigo-600 text-white hover:bg-indigo-700"
                          }`}
                          title={t("playTranslation")}
                        >
                          {germanResultsSpeaking ? "⏹" : "🔊"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            copyToClipboard(results.translation, "german");
                          }}
                          disabled={!results.translation}
                          className={`px-3 py-1 rounded-md text-sm ${
                            germanResultsCopiedId
                              ? "bg-green-600 text-white"
                              : "bg-gray-200 text-gray-700"
                          } hover:bg-gray-300 disabled:opacity-50`}
                          title={
                            germanResultsCopiedId ? t("copied") : t("copy")
                          }
                        >
                          {germanResultsCopiedId ? t("copied") : t("copy")}
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  <TranslationFeature germanText={results.translation} />

                  {/* Metadata */}
                  <div className="grid grid-cols-2 gap-4 pt-4 border-t">
                    <div>
                      <p className="text-sm text-gray-600">{t("confidence")}</p>
                      <p className="text-lg font-semibold text-gray-800">
                        {(results.confidence * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">
                        {t("processingTime")}
                      </p>
                      <p className="text-lg font-semibold text-gray-800">
                        {results.processingTime}
                      </p>
                    </div>
                  </div>

                  {/* <div className="pt-4 border-t">
                    <p className="text-sm text-gray-600">{t("methodUsed")}</p>
                    <p className="text-sm font-medium text-gray-800">
                      {results.method}
                    </p>
                  </div> */}
                </div>
              </div>
            )}

            {/* Translation History */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-800">
                  {t("translationHistory")}
                </h2>
                <button
                  onClick={clearHistory}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  {t("clear")}
                </button>
              </div>
              {translationHistory.length === 0 ? (
                <p className="text-sm text-gray-500">{t("noTranslations")}</p>
              ) : (
                <ul className="space-y-3 max-h-56 overflow-y-auto">
                  {translationHistory.map((rec) => {
                    const conf = getConfidenceValue(rec.confidence);
                    const speakingThis = historySpeakingId === rec.id;
                    // rec.method may be a stored key (new) or a label (old). Prefer localized label when key is present.
                    const methodLabel =
                      translationMethods[rec.method] || rec.method;
                    return (
                      <li
                        key={rec.id}
                        className="relative p-3 border rounded-lg flex items-start justify-between"
                      >
                        <div className="flex-1 mr-3">
                          <div className="text-sm text-gray-600">
                            {rec.time} {" "}
                            {/* <span className="text-xs text-gray-500">
                              {methodLabel}
                            </span> */}
                          </div>
                          <div className="mt-1 text-gray-800">
                            {rec.translation}
                          </div>
                        </div>
                        <div className="ml-2 flex-shrink-0 flex items-center space-x-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              speakTranslation(rec.translation, "de-DE", "history", rec.id);
                            }}
                            className={`px-2 py-1 rounded-md text-sm ${
                              speakingThis
                                ? "bg-gray-200 text-gray-700"
                                : "bg-indigo-600 text-white hover:bg-indigo-700"
                            }`}
                            title={
                              speakingThis
                                ? t('stopSpeaking')
                                : t('playTranslation')
                            }
                          >
                            {speakingThis ? "⏹" : "🔊"}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              copyToClipboard(rec.translation, "history", rec.id);
                            }}
                            className={`px-2 py-1 rounded-md text-sm ${
                              historyCopiedId === rec.id
                                ? "bg-green-600 text-white"
                                : "bg-gray-200 text-gray-700"
                            }`}
                            title={
                              historyCopiedId === rec.id
                                ? t('copied')
                                : (t('copyTranslation'))
                            }
                          >
                            {historyCopiedId === rec.id ? "✓" : "📋"}
                          </button>
                          <div
                            className={`${getConfidenceClass(
                              conf
                            )} px-2 py-1 rounded-full text-sm font-semibold`}
                          >
                            {(conf * 100).toFixed(0)}%
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            deleteHistoryItem(rec.id);
                          }}
                          className="absolute bottom-2 right-2 text-sm opacity-40 hover:opacity-100 transition-opacity"
                          title={t('delete')}
                        >
                          🗑️
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Instructions */}
              <div className="bg-white rounded-lg shadow-lg p-6">
                <h2 className="text-xl font-semibold text-gray-800 mb-4">
                  {t("howItWorksTitle")}
                </h2>

                <ol className="space-y-3 text-gray-600">
                  <li className="flex items-start">
                    <span className="bg-indigo-100 text-indigo-600 rounded-full w-6 h-6 flex items-center justify-center text-sm font-semibold mr-3 flex-shrink-0">
                      1
                    </span>
                    <span>{t("how1")}</span>
                  </li>
                  <li className="flex items-start">
                    <span className="bg-indigo-100 text-indigo-600 rounded-full w-6 h-6 flex items-center justify-center text-sm font-semibold mr-3 flex-shrink-0">
                      2
                    </span>
                    <span>{t("how2")}</span>
                  </li>
                  <li className="flex items-start">
                    <span className="bg-indigo-100 text-indigo-600 rounded-full w-6 h-6 flex items-center justify-center text-sm font-semibold mr-3 flex-shrink-0">
                      3
                    </span>
                    <span>{t("how3")}</span>
                  </li>
                  <li className="flex items-start">
                    <span className="bg-indigo-100 text-indigo-600 rounded-full w-6 h-6 flex items-center justify-center text-sm font-semibold mr-3 flex-shrink-0">
                      4
                    </span>
                    <span>{t("how4")}</span>
                  </li>
                </ol>

                <div className="mt-6 p-4 bg-blue-50 rounded-lg">
                  <p className="text-sm text-blue-800">
                    <strong>{t("privacyTitle")}:</strong> {t("privacyText")}
                  </p>
                </div>
              </div>
          </div>
        </div>
      </div>
      {/* Hidden video and canvas for processing (MUST be in the DOM) */}
      <video
        ref={videoRef}
        className="hidden"
        crossOrigin="anonymous"
        onLoadedMetadata={(e) => {
          // This is a small fix to ensure the video can be read for landmark extraction
          if (e.currentTarget.duration) {
            e.currentTarget.currentTime = 0;
          }
        }}
      />
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default SignLanguageTranslator;
