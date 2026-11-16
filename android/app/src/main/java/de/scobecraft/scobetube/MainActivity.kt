package de.scobecraft.scobetube

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.text.method.ScrollingMovementMethod
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.animation.AccelerateInterpolator
import android.view.animation.BounceInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.res.ResourcesCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var loadBar: View
    private lateinit var intro: FrameLayout
    private lateinit var introVinyl: VinylView
    private lateinit var setup: View
    private lateinit var setupCard: View
    private lateinit var offline: View
    private lateinit var updateLayer: FrameLayout
    private lateinit var updateCard: LinearLayout
    private lateinit var confetti: ConfettiView

    private val prefs by lazy { getSharedPreferences("scobetube", MODE_PRIVATE) }
    private var server: String?
        get() = prefs.getString("server", null)
        set(v) { prefs.edit().putString("server", v).apply() }

    private val d by lazy { resources.displayMetrics.density }
    private var introStarted = 0L
    private var introDone = false
    private var pageLoaded = false
    private var pendingShare: String? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private var release: Updater.Release? = null
    private var downloadedApk: File? = null
    private var downloading = false
    private var awaitingInstallPermission = false
    private var lastUpdateCheck = 0L
    private var pulse: ObjectAnimator? = null
    private var wobble: ObjectAnimator? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }

    // =============================================================== Start
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        swipe = findViewById(R.id.swipe)
        loadBar = findViewById(R.id.loadBar)
        intro = findViewById(R.id.intro)
        introVinyl = findViewById(R.id.introVinyl)
        setup = findViewById(R.id.setup)
        setupCard = findViewById(R.id.setupCard)
        offline = findViewById(R.id.offline)
        updateLayer = findViewById(R.id.update)
        updateCard = findViewById(R.id.updateCard)
        confetti = findViewById(R.id.confetti)

        // Ränder für Statusleiste, Navigationsleiste und Tastatur
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        setupWebView()
        setupButtons()
        buildIntroTitle()
        playIntro()
        handleIntent(intent)

        if (server == null) {
            root.postDelayed({ hideIntro(); showSetup(changing = false) }, 1700)
        } else {
            loadStart()
            checkForUpdate(force = false)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    updateLayer.isVisible && !downloading -> hideUpdate()
                    setup.isVisible && server != null -> hideSetup()
                    web.canGoBack() -> web.goBack()
                    else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
        if (server != null && pendingShare != null) loadStart()
    }

    override fun onResume() {
        super.onResume()
        if (awaitingInstallPermission && Updater.canInstall(this)) {
            awaitingInstallPermission = false
            installNow()
        } else if (server != null && SystemClock.elapsedRealtime() - lastUpdateCheck > 30 * 60_000) {
            checkForUpdate(force = false)
        }
        web.onResume()
    }

    override fun onPause() { web.onPause(); CookieManager.getInstance().flush(); super.onPause() }

    /** „Teilen“ aus anderen Apps: Link wird an /share übergeben – gestartet wird erst per Tipp. */
    private fun handleIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        val title = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""
        val s = server
        pendingShare = if (s != null) "$s/share?text=${enc(text)}&title=${enc(title)}" else null
        if (s == null) Toast.makeText(this, "Richte zuerst deinen Server ein", Toast.LENGTH_LONG).show()
    }

    private fun loadStart() {
        val url = pendingShare ?: server ?: return
        pendingShare = null
        web.loadUrl(url)
    }

    // ============================================================ WebView
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            userAgentString = "$userAgentString ScobeTubeApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(web, false) }
        web.addJavascriptInterface(AppBridge(this), "ScobeAndroid")
        web.setBackgroundColor(Color.parseColor("#0B0B0C"))

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "blob" || url.scheme == "data") return false
                if (isOwnServer(url)) return false
                // Fremde Seiten (z. B. „Originalseite öffnen“) im Browser bzw. in der passenden App öffnen
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                loadBar.animate().cancel(); loadBar.alpha = 1f; loadBar.scaleX = 0.08f
            }

            override fun onPageFinished(view: WebView, url: String?) {
                swipe.isRefreshing = false
                loadBar.animate().scaleX(1f).setDuration(200).withEndAction {
                    loadBar.animate().alpha(0f).setDuration(250)
                }
                if (!offline.isVisible) { pageLoaded = true; maybeFinishIntro() }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline(error.description?.toString())
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, p: Int) {
                loadBar.animate().scaleX(maxOf(0.08f, p / 100f)).setDuration(150)
            }

            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return runCatching { fileChooser.launch(params.createIntent()); true }.getOrElse { fileCallback = null; false }
            }
        }
        web.setDownloadListener { url, ua, disposition, mime, _ -> download(url, ua, disposition, mime) }

        swipe.setColorSchemeColors(getColor(R.color.ink))
        swipe.setProgressBackgroundColorSchemeColor(getColor(R.color.accent))
        swipe.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 }
        swipe.setOnRefreshListener { haptic(); web.reload() }
    }

    private fun isOwnServer(url: Uri): Boolean {
        val s = server?.let { Uri.parse(it) } ?: return false
        return url.host.equals(s.host, ignoreCase = true) && (url.port == s.port || url.port == -1 || s.port == -1)
    }

    private fun download(url: String, ua: String, disposition: String?, mime: String?) {
        if (url.startsWith("blob:")) {
            // blob:-Inhalte (z. B. Wiederherstellungscodes) über die App-Brücke speichern
            web.evaluateJavascript("""(async()=>{const r=await fetch('$url');const b=await r.blob();const f=new FileReader();
                f.onload=()=>ScobeAndroid.saveFile(f.result.split(',')[1],'scobetube-datei',b.type);f.readAsDataURL(b);})()""", null)
            return
        }
        val name = URLUtil.guessFileName(url, disposition, mime)
        val req = DownloadManager.Request(Uri.parse(url)).apply {
            CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
            addRequestHeader("User-Agent", ua)
            setTitle(name)
            setDescription("ScobeTube")
            setMimeType(mime)
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "ScobeTube/$name")
        }
        runCatching { (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req) }
            .onSuccess { haptic(); Toast.makeText(this, "⬇ $name wird gespeichert", Toast.LENGTH_SHORT).show() }
            .onFailure { Toast.makeText(this, "Download nicht möglich: ${it.message}", Toast.LENGTH_LONG).show() }
    }

    // ============================================================== Intro
    private fun buildIntroTitle() {
        val box = findViewById<LinearLayout>(R.id.introTitle)
        val font = ResourcesCompat.getFont(this, R.font.unbounded)
        "SCOBE//TUBE".forEachIndexed { i, c ->
            box.addView(TextView(this).apply {
                text = c.toString()
                typeface = font
                fontVariationSettings = "'wght' 900"
                textSize = 32f
                setTextColor(getColor(if (c == '/') R.color.accent else R.color.paper))
                alpha = 0f
                translationY = 60 * d
                rotation = 12f
                tag = i
            })
        }
    }

    private fun playIntro() {
        introStarted = SystemClock.elapsedRealtime()
        findViewById<View>(R.id.introGlow).animate().alpha(1f).setDuration(900).start()

        introVinyl.scaleX = 0f; introVinyl.scaleY = 0f
        introVinyl.speed = 1.4f
        introVinyl.start()
        introVinyl.animate().scaleX(1f).scaleY(1f).setStartDelay(80).setDuration(750)
            .setInterpolator(OvershootInterpolator(1.6f)).start()
        ValueAnimator.ofFloat(1.4f, 0.35f).apply {
            startDelay = 600; duration = 1200
            addUpdateListener { introVinyl.speed = it.animatedValue as Float }
            start()
        }

        val logo = findViewById<View>(R.id.introLogo)
        logo.translationY = -700 * d; logo.rotation = -28f
        logo.animate().translationY(0f).rotation(0f).setStartDelay(260).setDuration(950)
            .setInterpolator(BounceInterpolator()).start()

        val title = findViewById<LinearLayout>(R.id.introTitle)
        for (i in 0 until title.childCount) {
            title.getChildAt(i).animate().alpha(1f).translationY(0f).rotation(0f)
                .setStartDelay(650L + i * 45).setDuration(520).setInterpolator(OvershootInterpolator(2f)).start()
        }

        val sticker = findViewById<View>(R.id.introSticker)
        sticker.scaleX = 0f; sticker.scaleY = 0f
        sticker.animate().scaleX(1f).scaleY(1f).rotation(-3f).setStartDelay(1250).setDuration(420)
            .setInterpolator(OvershootInterpolator(3f)).start()
    }

    private fun maybeFinishIntro() {
        if (introDone || !pageLoaded) return
        val wait = 1700 - (SystemClock.elapsedRealtime() - introStarted)
        if (wait > 0) root.postDelayed({ maybeFinishIntro() }, wait) else hideIntro()
    }

    private fun hideIntro() {
        if (introDone) return
        introDone = true
        ValueAnimator.ofFloat(introVinyl.speed, 3f).apply {
            duration = 450
            addUpdateListener { introVinyl.speed = it.animatedValue as Float }
            start()
        }
        intro.animate().alpha(0f).scaleX(1.15f).scaleY(1.15f).setStartDelay(120).setDuration(480)
            .setInterpolator(AccelerateInterpolator()).withEndAction { intro.isVisible = false; introVinyl.stop() }.start()
        swipe.scaleX = 0.94f; swipe.scaleY = 0.94f
        swipe.animate().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(260).setDuration(520)
            .setInterpolator(DecelerateInterpolator(2f)).start()
    }

    // ========================================================= Einrichtung
    fun showSetup(changing: Boolean) {
        val input = findViewById<EditText>(R.id.setupUrl)
        input.setText(server ?: BuildConfig.DEFAULT_SERVER)
        input.setSelection(input.text.length)
        findViewById<TextView>(R.id.setupTitle).text = if (changing) "SERVER" else "HALLO!"
        findViewById<TextView>(R.id.setupMsg).text = ""
        setup.alpha = 0f; setup.isVisible = true
        setup.animate().alpha(1f).setDuration(250).start()
        setupCard.translationY = 400 * d; setupCard.rotation = 4f
        setupCard.animate().translationY(0f).rotation(0f).setDuration(650)
            .setInterpolator(OvershootInterpolator(1.3f)).start()
    }

    private fun hideSetup() {
        hideKeyboard()
        setupCard.animate().translationY(500 * d).rotation(-4f).setDuration(380).setInterpolator(AccelerateInterpolator()).start()
        setup.animate().alpha(0f).setStartDelay(150).setDuration(300).withEndAction { setup.isVisible = false }.start()
    }

    private fun connect() {
        val input = findViewById<EditText>(R.id.setupUrl)
        val msg = findViewById<TextView>(R.id.setupMsg)
        val go = findViewById<TextView>(R.id.setupGo)
        var url = input.text.toString().trim().trimEnd('/')
        if (url.isEmpty()) return
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
        go.text = "VERBINDE …"; msg.text = ""
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val c = URL("$url/healthz").openConnection() as HttpURLConnection
                    c.connectTimeout = 10_000; c.readTimeout = 10_000
                    c.responseCode == 200 && c.inputStream.bufferedReader().readText().contains("ok")
                }.getOrDefault(false)
            }
            go.text = "VERBINDEN  →"
            if (!ok) {
                msg.text = "Unter dieser Adresse antwortet kein ScobeTube-Server."
                shake(setupCard); return@launch
            }
            haptic()
            val changed = url != server
            server = url
            if (url.startsWith("http://")) {
                Toast.makeText(this@MainActivity, "⚠ Unverschlüsselte Verbindung – Passwörter gehen im Klartext übers Netz.", Toast.LENGTH_LONG).show()
            }
            hideSetup()
            hideOffline()
            if (changed || !pageLoaded) { pageLoaded = false; loadStart() }
            checkForUpdate(force = false)
        }
    }

    // ============================================================= Offline
    private fun showOffline(reason: String?) {
        if (offline.isVisible) return
        findViewById<TextView>(R.id.offlineMsg).text =
            "Der Server ist gerade nicht erreichbar.\n${reason.orEmpty()}".trim()
        offline.alpha = 0f; offline.isVisible = true
        offline.animate().alpha(1f).setDuration(300).start()
        findViewById<VinylView>(R.id.offlineVinyl).apply { speed = 0.08f; start() }
        hideIntro()
    }

    private fun hideOffline() {
        if (!offline.isVisible) return
        findViewById<VinylView>(R.id.offlineVinyl).stop()
        offline.animate().alpha(0f).setDuration(250).withEndAction { offline.isVisible = false }.start()
    }

    // ============================================================= Updates
    fun checkForUpdate(force: Boolean) {
        val s = server ?: return
        if (updateLayer.isVisible) return
        lastUpdateCheck = SystemClock.elapsedRealtime()
        lifecycleScope.launch {
            val rel = Updater.check(s)
            if (rel == null) {
                if (force) Toast.makeText(this@MainActivity, "Du hast die neueste Version (${BuildConfig.VERSION_NAME}) ✓", Toast.LENGTH_SHORT).show()
                return@launch
            }
            release = rel
            // Ein bisschen warten, damit das Intro nicht überdeckt wird
            root.postDelayed({ showUpdate(rel) }, if (introDone) 300 else 2100)
        }
    }

    private fun showUpdate(rel: Updater.Release) {
        if (updateLayer.isVisible) return
        findViewById<TextView>(R.id.updateVersion).text = "v${BuildConfig.VERSION_NAME}  →  v${rel.name}"
        findViewById<TextView>(R.id.updateNotes).apply {
            text = cleanNotes(rel.notes)
            movementMethod = ScrollingMovementMethod()
        }
        findViewById<ProgressBar>(R.id.updateProgress).apply { isVisible = false; progress = 0 }
        findViewById<TextView>(R.id.updateStatus).isVisible = false
        val go = findViewById<TextView>(R.id.updateGo)
        go.text = "JETZT INSTALLIEREN"; go.alpha = 1f
        findViewById<TextView>(R.id.updateLater).isVisible = true

        updateLayer.isVisible = true
        val dim = findViewById<View>(R.id.updateDim)
        dim.alpha = 0f; dim.animate().alpha(1f).setDuration(320).start()

        // Karte schwingt von unten herein
        updateCard.alpha = 0f; updateCard.translationY = 700 * d; updateCard.rotation = 9f
        updateCard.animate().alpha(1f).translationY(0f).rotation(0f).setStartDelay(80).setDuration(720)
            .setInterpolator(OvershootInterpolator(1.25f)).start()

        findViewById<VinylView>(R.id.updateVinyl).apply {
            scaleX = 0f; scaleY = 0f; speed = 1.2f; start()
            animate().scaleX(1f).scaleY(1f).setStartDelay(380).setDuration(600).setInterpolator(OvershootInterpolator(2f)).start()
        }
        val badge = findViewById<View>(R.id.updateBadge)
        badge.scaleX = 0f; badge.scaleY = 0f
        badge.animate().scaleX(1f).scaleY(1f).setStartDelay(620).setDuration(450)
            .setInterpolator(OvershootInterpolator(3.5f)).withEndAction {
                wobble = ObjectAnimator.ofFloat(badge, "rotation", 8f, -5f).apply {
                    duration = 700; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; start()
                }
            }.start()

        pulse = ObjectAnimator.ofPropertyValuesHolder(go,
            android.animation.PropertyValuesHolder.ofFloat("scaleX", 1f, 1.045f),
            android.animation.PropertyValuesHolder.ofFloat("scaleY", 1f, 1.045f)).apply {
            duration = 650; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; startDelay = 900; start()
        }
        root.postDelayed({
            confetti.burst(updateCard.x + updateCard.width / 2f, updateCard.y + 40 * d, 90)
            haptic()
        }, 520)
    }

    private fun hideUpdate() {
        pulse?.cancel(); wobble?.cancel()
        findViewById<VinylView>(R.id.updateVinyl).stop()
        updateCard.animate().translationY(700 * d).rotation(-8f).alpha(0f).setDuration(420)
            .setInterpolator(AccelerateInterpolator()).start()
        findViewById<View>(R.id.updateDim).animate().alpha(0f).setStartDelay(120).setDuration(300)
            .withEndAction { updateLayer.isVisible = false }.start()
    }

    private fun startDownload() {
        val rel = release ?: return
        if (downloading) return
        downloadedApk?.takeIf { it.exists() }?.let { installNow(); return }
        downloading = true
        pulse?.cancel(); findViewById<View>(R.id.updateGo).apply { scaleX = 1f; scaleY = 1f }
        val bar = findViewById<ProgressBar>(R.id.updateProgress)
        val status = findViewById<TextView>(R.id.updateStatus)
        val go = findViewById<TextView>(R.id.updateGo)
        val vinyl = findViewById<VinylView>(R.id.updateVinyl)
        findViewById<View>(R.id.updateLater).isVisible = false
        bar.isVisible = true; status.isVisible = true
        status.setTextColor(getColor(R.color.paper2))
        go.text = "LÄDT …"; go.alpha = 0.6f
        vinyl.speed = 2.6f
        lifecycleScope.launch {
            try {
                val mb = rel.size / 1_048_576f
                val file = Updater.download(this@MainActivity, rel) { p ->
                    ObjectAnimator.ofInt(bar, "progress", bar.progress, (p * 1000).toInt()).setDuration(180).start()
                    status.text = "Lade … ${(p * 100).toInt()} %" + if (mb > 0) "  ·  %.1f / %.1f MB".format(p * mb, mb) else ""
                }
                downloadedApk = file
                vinyl.speed = 0.5f
                status.text = "✓ Geprüft – Installation startet …"
                go.text = "INSTALLIEREN"; go.alpha = 1f
                confetti.burst(updateCard.x + updateCard.width / 2f, updateCard.y + updateCard.height * 0.7f, 60)
                haptic()
                root.postDelayed({ installNow() }, 700)
            } catch (e: Exception) {
                vinyl.speed = 0.3f
                status.setTextColor(getColor(R.color.red))
                status.text = e.message ?: "Download fehlgeschlagen"
                go.text = "NOCHMAL VERSUCHEN"; go.alpha = 1f
                findViewById<View>(R.id.updateLater).isVisible = true
                shake(updateCard)
            } finally {
                downloading = false
            }
        }
    }

    private fun installNow() {
        val file = downloadedApk ?: return
        if (!Updater.canInstall(this)) {
            findViewById<TextView>(R.id.updateStatus).apply {
                isVisible = true
                text = "Bitte erlaube ScobeTube kurz, Apps zu installieren – danach geht's automatisch weiter."
            }
            awaitingInstallPermission = true
            Updater.openInstallPermission(this)
            return
        }
        Updater.install(this, file)
    }

    private fun cleanNotes(notes: String): String =
        notes.ifBlank { "Verbesserungen und Fehlerbehebungen." }
            .replace(Regex("(?m)^#+\\s*"), "")
            .replace("**", "")
            .replace(Regex("(?m)^\\s*[-*]\\s+"), "•  ")
            .trim()

    // ============================================================ Helfer
    private fun setupButtons() {
        val setupGo = findViewById<View>(R.id.setupGo)
        pressable(setupGo); setupGo.setOnClickListener { connect() }
        findViewById<EditText>(R.id.setupUrl).setOnEditorActionListener { _, id, _ ->
            if (id == EditorInfo.IME_ACTION_GO) { connect(); true } else false
        }
        val retry = findViewById<View>(R.id.offlineRetry)
        pressable(retry); retry.setOnClickListener { haptic(); hideOffline(); pageLoaded = false; web.reload().also { if (web.url == null) loadStart() } }
        findViewById<View>(R.id.offlineServer).setOnClickListener { showSetup(changing = true) }
        val go = findViewById<View>(R.id.updateGo)
        pressable(go); go.setOnClickListener { haptic(); startDownload() }
        findViewById<View>(R.id.updateLater).setOnClickListener { hideUpdate() }
        findViewById<View>(R.id.updateDim).setOnClickListener { if (!downloading) hideUpdate() }
    }

    /** Knöpfe „drücken sich ein“ wie auf der Webseite (harter Schatten). */
    @SuppressLint("ClickableViewAccessibility")
    private fun pressable(v: View) {
        v.setOnTouchListener { view, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> view.animate().translationX(4 * d).translationY(4 * d).setDuration(70).start()
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                    view.animate().translationX(0f).translationY(0f).setDuration(220).setInterpolator(OvershootInterpolator(3f)).start()
            }
            false
        }
    }

    private fun shake(v: View) {
        ObjectAnimator.ofFloat(v, "translationX", 0f, -14 * d, 12 * d, -8 * d, 5 * d, 0f).setDuration(420).start()
        haptic()
    }

    fun haptic() {
        root.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
    }

    private fun hideKeyboard() {
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(root.windowToken, 0)
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
