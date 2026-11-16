package de.scobecraft.scobetube

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Neue App-Versionen vom eigenen ScobeTube-Server holen und installieren. */
object Updater {

    data class Release(
        val code: Int, val name: String, val notes: String,
        val size: Long, val sha256: String, val url: String,
    )

    private fun open(url: String, timeout: Int = 15_000): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeout; readTimeout = timeout
            setRequestProperty("User-Agent", "ScobeTubeApp/${BuildConfig.VERSION_NAME}")
            instanceFollowRedirects = true
        }

    /** Fragt den Server nach der aktuellen App-Version. null = keine Info / kein Update. */
    suspend fun check(server: String): Release? = withContext(Dispatchers.IO) {
        runCatching {
            val conn = open("$server/api/app/version")
            if (conn.responseCode != 200) return@runCatching null
            val j = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            if (!j.optBoolean("available")) return@runCatching null
            val rel = Release(
                code = j.getInt("version_code"), name = j.getString("version_name"),
                notes = j.optString("notes"), size = j.optLong("size"), sha256 = j.optString("sha256"),
                url = j.optString("download").let { if (it.startsWith("http")) it else "$server/${it.trimStart('/')}" },
            )
            if (rel.code > BuildConfig.VERSION_CODE) rel else null
        }.getOrNull()
    }

    /** Lädt die APK herunter (mit Fortschritt 0..1) und prüft sie gründlich. */
    suspend fun download(context: Context, rel: Release, progress: (Float) -> Unit): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        val file = File(dir, "scobetube-${rel.name}.apk")
        val conn = open(rel.url, 60_000)
        if (conn.responseCode != 200) error("Download fehlgeschlagen (HTTP ${conn.responseCode})")
        val total = conn.contentLengthLong.takeIf { it > 0 } ?: rel.size
        val digest = MessageDigest.getInstance("SHA-256")
        conn.inputStream.use { input ->
            file.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n); digest.update(buf, 0, n); done += n
                    if (total > 0) withContext(Dispatchers.Main) { progress((done.toFloat() / total).coerceIn(0f, 1f)) }
                }
            }
        }
        // 1) Prüfsumme
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        if (rel.sha256.isNotEmpty() && !sha.equals(rel.sha256, ignoreCase = true)) {
            file.delete(); error("Prüfsumme stimmt nicht – Download beschädigt")
        }
        // 2) Wirklich ScobeTube und wirklich neuer?
        val info = context.packageManager.getPackageArchiveInfo(file.path, 0)
            ?: run { file.delete(); error("Die Datei ist keine gültige App") }
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else info.versionCode
        if (info.packageName != context.packageName) { file.delete(); error("Falsche App im Update") }
        if (code <= BuildConfig.VERSION_CODE) { file.delete(); error("Das Update ist nicht neuer") }
        file
    }

    /** true = Android erlaubt uns, Updates zu installieren. */
    fun canInstall(context: Context): Boolean =
        context.packageManager.canRequestPackageInstalls()

    fun openInstallPermission(context: Context) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
    }

    /** Startet die Installation (Android zeigt danach den System-Dialog „Aktualisieren?“). */
    fun install(context: Context, file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
