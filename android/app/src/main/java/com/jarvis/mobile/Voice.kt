package com.jarvis.mobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Native speech for the WebView (Android WebView has no Web Speech API).
 * Recognition events go to JS as window.__jarvisSpeech(json); TTS completion as window.__jarvisTts(id).
 */
class Voice(
    private val ctx: Context,
    private val emit: (String) -> Unit,
    private val ttsDone: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private var recognizer: SpeechRecognizer? = null
    private var session = 0

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsInitDone = false
    private val pendingSpeech = mutableListOf<() -> Unit>()
    private var focusRequest: AudioFocusRequest? = null

    init {
        main.post { initTts() }
    }

    // ------------------------------------------------------------------ recognition

    fun startListening(lang: String, continuous: Boolean) = main.post {
        val id = ++session
        if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            event("error", "error" to "not-allowed"); event("end"); return@post
        }
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            event("error", "error" to "service-not-allowed"); event("end"); return@post
        }
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = r
        var ended = false
        fun finish() {
            if (ended || id != session) return
            ended = true
            event("end")
        }
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { if (id == session) event("start") }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onPartialResults(partialResults: Bundle?) {
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (id == session && !text.isNullOrBlank()) event("result", "text" to text, "final" to false)
            }

            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (id == session && !text.isNullOrBlank()) event("result", "text" to text, "final" to true)
                finish()
            }

            override fun onError(error: Int) {
                if (id != session) return
                when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> event("error", "error" to "not-allowed")
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> event("error", "error" to "network")
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                        if (!continuous) event("error", "error" to "no-speech")
                    else -> {}
                }
                finish()
            }
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            if (lang.isNotBlank()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
            if (continuous) {
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
            }
        }
        // In wake-word mode the recognizer restarts constantly; hide its start "beep".
        if (continuous) muteBeepBriefly()
        try {
            r.startListening(intent)
        } catch (e: Exception) {
            event("error", "error" to "aborted"); finish()
        }
    }

    fun stopListening() = main.post {
        session++
        recognizer?.let {
            try { it.cancel() } catch (ignored: Exception) {}
            it.destroy()
        }
        recognizer = null
    }

    private fun muteBeepBriefly() {
        val streams = intArrayOf(AudioManager.STREAM_SYSTEM, AudioManager.STREAM_NOTIFICATION)
        try {
            streams.forEach { audio.adjustStreamVolume(it, AudioManager.ADJUST_MUTE, 0) }
        } catch (ignored: Exception) { return } // e.g. Do Not Disturb forbids changing these
        main.postDelayed({
            try { streams.forEach { audio.adjustStreamVolume(it, AudioManager.ADJUST_UNMUTE, 0) } } catch (ignored: Exception) {}
        }, 700)
    }

    private fun event(type: String, vararg fields: Pair<String, Any>) {
        val o = JSONObject().put("type", type)
        fields.forEach { (k, v) -> o.put(k, v) }
        emit(o.toString())
    }

    // ------------------------------------------------------------------ text to speech

    private fun initTts() {
        tts = TextToSpeech(ctx) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            ttsInitDone = true
            if (ttsReady) {
                tts?.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) = done(utteranceId)
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) = done(utteranceId)
                    override fun onError(utteranceId: String?, errorCode: Int) = done(utteranceId)
                    override fun onStop(utteranceId: String?, interrupted: Boolean) = done(utteranceId)
                })
            }
            val queued = pendingSpeech.toList()
            pendingSpeech.clear()
            queued.forEach { it() }
        }
    }

    private fun done(id: String?) {
        main.post { releaseFocus() }
        if (id != null) ttsDone(id)
    }

    fun speak(id: String, text: String, lang: String, rate: Float, voiceName: String) = main.post {
        val job = {
            val t = tts
            if (!ttsReady || t == null) {
                ttsDone(id)
            } else {
                val voice = if (voiceName.isNotBlank()) t.voices?.firstOrNull { it.name == voiceName } else null
                if (voice != null) t.setVoice(voice)
                else if (lang.isNotBlank()) t.setLanguage(Locale.forLanguageTag(lang))
                t.setSpeechRate(rate.coerceIn(0.5f, 2f))
                requestFocus()
                if (t.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) done(id)
            }
        }
        if (!ttsInitDone) pendingSpeech.add(job) else job()
    }

    fun stopSpeaking() = main.post {
        tts?.stop()
        releaseFocus()
    }

    fun voices(): String {
        val arr = JSONArray()
        try {
            tts?.voices
                ?.filter { !it.isNetworkConnectionRequired && !it.features.contains("notInstalled") }
                ?.sortedBy { it.locale.toLanguageTag() + it.name }
                ?.forEach { arr.put(JSONObject().put("name", it.name).put("lang", it.locale.toLanguageTag())) }
        } catch (ignored: Exception) {}
        return arr.toString()
    }

    private fun requestFocus() {
        if (focusRequest != null) return
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
            ).build()
        audio.requestAudioFocus(req)
        focusRequest = req
    }

    private fun releaseFocus() {
        focusRequest?.let { audio.abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    fun destroy() = main.post {
        session++
        recognizer?.destroy(); recognizer = null
        tts?.shutdown(); tts = null
        releaseFocus()
    }
}
