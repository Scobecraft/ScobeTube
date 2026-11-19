package de.scobecraft.scobetube

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Push-Benachrichtigungen ohne Google-Dienste: Die App fragt den eigenen ScobeTube-Server
 * regelmäßig (Android erlaubt alle 15 Minuten) und beim Öffnen nach neuen Nachrichten –
 * z. B. Speicher-Anfragen für Admins, Antworten darauf oder verdächtige Anmeldeversuche.
 */
object Push {
    private const val CHANNEL = "scobetube_news"
    private const val WORK = "scobetube_push"
    const val EXTRA_OPEN = "scobetube_open"

    /** true, solange die App sichtbar ist – dann zeigt die Webseite die Nachrichten selbst an. */
    @Volatile var foreground = false

    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<PushWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun cancel(ctx: Context) = WorkManager.getInstance(ctx).cancelUniqueWork(WORK)

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) != null) return
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "ScobeTube-Nachrichten", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Speicher-Anfragen, Antworten der Admins, geteilte Downloads und Sicherheitswarnungen"
            enableLights(true); lightColor = Color.parseColor("#C6FF3D")
        })
    }

    fun allowed(ctx: Context): Boolean = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * Neue Nachrichten holen. Beim allerersten Mal wird nur der Stand gemerkt (keine Flut alter Meldungen).
     * @return false, wenn nicht angemeldet / kein Server – dann gibt es nichts zu tun.
     */
    fun check(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences("scobetube", Context.MODE_PRIVATE)
        val server = prefs.getString("server", null) ?: return false
        val cookie = runCatching { CookieManager.getInstance().getCookie(server) }.getOrNull() ?: return false
        val last = prefs.getInt("push_last", -1)
        val conn = (URL("$server/api/notifications?after=${maxOf(last, 0)}").openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000; readTimeout = 20_000
            setRequestProperty("Cookie", cookie)
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "ScobeTubeApp/${BuildConfig.VERSION_NAME}")
            instanceFollowRedirects = false
        }
        try {
            if (conn.responseCode != 200) return false
            val data = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val latest = data.optInt("latest", 0)
            val list = data.optJSONArray("notifications")
            if (last < 0 || latest < last) {   // erster Lauf oder Server zurückgesetzt
                prefs.edit().putInt("push_last", latest).apply()
                return true
            }
            var newest = last
            if (list != null) for (i in 0 until list.length()) {
                val n = list.getJSONObject(i)
                val id = n.optInt("id")
                if (id <= last) continue
                newest = maxOf(newest, id)
                if (!foreground && !n.optBoolean("read")) show(ctx, server, n)
            }
            prefs.edit().putInt("push_last", maxOf(newest, last)).apply()
            return true
        } finally {
            conn.disconnect()
        }
    }

    private fun show(ctx: Context, server: String, n: JSONObject) {
        if (!allowed(ctx)) return
        ensureChannel(ctx)
        val link = n.optString("link")
        val open = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_OPEN, if (link.startsWith("#")) "$server/$link" else server)
        }
        val id = n.optInt("id")
        val pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = n.optString("body")
        val notif = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_scobetube)
            .setColor(Color.parseColor("#C6FF3D"))
            .setContentTitle(n.optString("title", "ScobeTube"))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(if (n.optString("kind") == "security") NotificationCompat.CATEGORY_ERROR else NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setWhen((n.optDouble("ts", 0.0) * 1000).toLong().takeIf { it > 0 } ?: System.currentTimeMillis())
            .setShowWhen(true)
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(id, notif)
        } catch (_: SecurityException) { /* Berechtigung entzogen */ }
    }
}

class PushWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result = try {
        Push.check(applicationContext)
        Result.success()
    } catch (_: Exception) {
        Result.retry()
    }
}
