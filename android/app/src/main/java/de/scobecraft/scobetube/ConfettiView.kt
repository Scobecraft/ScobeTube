package de.scobecraft.scobetube

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/** Eckiges Konfetti im ScobeTube-Stil. */
class ConfettiView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    private class Bit(var x: Float, var y: Float, var vx: Float, var vy: Float, var rot: Float, val vr: Float,
                      val size: Float, val color: Int, var life: Int, val flat: Boolean)

    private val bits = ArrayList<Bit>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val colors = intArrayOf(
        Color.parseColor("#B9FF33"), Color.parseColor("#B9FF33"), Color.parseColor("#F3F0E7"),
        Color.parseColor("#8F6BFF"), Color.parseColor("#FF4D8D"))
    private val d = resources.displayMetrics.density

    init { isClickable = false }

    fun burst(x: Float, y: Float, count: Int = 70) {
        repeat(count) {
            val a = Random.nextDouble(0.0, Math.PI * 2)
            val sp = (3 + Random.nextFloat() * 9) * d
            bits += Bit(x, y, (cos(a) * sp).toFloat(), (sin(a) * sp).toFloat() - 7 * d, Random.nextFloat() * 6,
                (Random.nextFloat() - .5f) * .5f, (5 + Random.nextFloat() * 7) * d,
                colors[Random.nextInt(colors.size)], 70 + Random.nextInt(50), Random.nextBoolean())
        }
        postInvalidateOnAnimation()
    }

    override fun onDraw(canvas: Canvas) {
        val it = bits.iterator()
        while (it.hasNext()) {
            val b = it.next()
            b.vy += 0.38f * d; b.vx *= 0.985f
            b.x += b.vx; b.y += b.vy; b.rot += b.vr; b.life--
            if (b.life <= 0 || b.y > height + 40 * d) { it.remove(); continue }
            paint.color = b.color
            paint.alpha = (minOf(1f, b.life / 25f) * 255).toInt()
            canvas.save()
            canvas.translate(b.x, b.y)
            canvas.rotate(Math.toDegrees(b.rot.toDouble()).toFloat())
            val h = if (b.flat) b.size * .38f else b.size
            canvas.drawRect(-b.size / 2, -h / 2, b.size / 2, h / 2, paint)
            canvas.restore()
        }
        if (bits.isNotEmpty()) postInvalidateOnAnimation()
    }
}
