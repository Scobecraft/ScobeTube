package de.scobecraft.scobetube

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File

/**
 * Schnittstelle für die Webseite (window.ScobeAndroid).
 * Nur für Seiten des eingerichteten Servers verfügbar – fremde Seiten werden in der App gar nicht geöffnet.
 */
class AppBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun changeServer() = activity.runOnUiThread { activity.showSetup(changing = true) }

    @JavascriptInterface
    fun checkUpdate() = activity.runOnUiThread { activity.checkForUpdate(force = true) }

    @JavascriptInterface
    fun vibrate() = activity.runOnUiThread { activity.haptic() }

    /** Speichert Inhalte aus blob:-Links (z. B. Wiederherstellungscodes) im Download-Ordner. */
    @JavascriptInterface
    fun saveFile(base64: String, filename: String, mime: String) {
        val safe = filename.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120).ifBlank { "scobetube-datei" }
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val ok = runCatching {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ScobeTube")
                }
                val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("kein Speicherort")
                activity.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            } else {
                @Suppress("DEPRECATION")
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ScobeTube").apply { mkdirs() }
                File(dir, safe).writeBytes(bytes)
            }
        }.isSuccess
        activity.runOnUiThread {
            Toast.makeText(activity, if (ok) "Gespeichert: Downloads/ScobeTube/$safe" else "Speichern fehlgeschlagen", Toast.LENGTH_LONG).show()
        }
    }
}
