package de.scobecraft.scobetube

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.SweepGradient
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator

/** Drehende Schallplatte mit Rillen, Glanz und Label in der Akzentfarbe. */
class VinylView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#111111") }
    private val groove = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.parseColor("#262626") }
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.parseColor("#F3F0E7") }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#B9FF33") }
    private val hole = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#0B0B0C") }
    private val sheen = Paint(Paint.ANTI_ALIAS_FLAG)
    private val play = android.graphics.Path()
    private var angle = 0f
    private var spinner: ValueAnimator? = null

    /** Umdrehungen pro Sekunde – kann jederzeit (auch animiert) geändert werden. */
    var speed = 0.35f

    fun start() {
        if (spinner != null) return
        var last = System.nanoTime()
        spinner = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1000
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener {
                val now = System.nanoTime()
                angle = (angle + (now - last) / 1e9f * 360f * speed) % 360f
                last = now
                invalidate()
            }
            start()
        }
    }

    fun stop() { spinner?.cancel(); spinner = null }

    override fun onDetachedFromWindow() { stop(); super.onDetachedFromWindow() }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        sheen.shader = SweepGradient(w / 2f, h / 2f,
            intArrayOf(Color.TRANSPARENT, 0x33FFFFFF, Color.TRANSPARENT, Color.TRANSPARENT, 0x22FFFFFF, Color.TRANSPARENT),
            floatArrayOf(0f, 0.08f, 0.16f, 0.5f, 0.58f, 0.66f))
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f; val cy = height / 2f
        val r = minOf(cx, cy) - rimWidth()
        rim.strokeWidth = rimWidth()
        canvas.drawCircle(cx, cy, r, disc)
        // Rillen
        groove.strokeWidth = maxOf(1f, r / 110f)
        var gr = r * 0.95f
        while (gr > r * 0.42f) { canvas.drawCircle(cx, cy, gr, groove); gr -= r / 26f }
        canvas.save()
        canvas.rotate(angle, cx, cy)
        canvas.drawCircle(cx, cy, r, sheen)
        // Label mit kleinem Play-Symbol (dreht sich mit)
        canvas.drawCircle(cx, cy, r * 0.36f, label)
        val s = r * 0.13f
        play.reset()
        play.moveTo(cx - s * 0.55f, cy - s * 1.6f); play.lineTo(cx - s * 0.55f, cy - s * 0.5f); play.lineTo(cx + s * 0.4f, cy - s * 1.05f); play.close()
        canvas.drawPath(play, hole)
        canvas.restore()
        canvas.drawCircle(cx, cy, r * 0.05f, hole)
        canvas.drawCircle(cx, cy, r, rim)
    }

    private fun rimWidth() = resources.displayMetrics.density * 2.5f
}
