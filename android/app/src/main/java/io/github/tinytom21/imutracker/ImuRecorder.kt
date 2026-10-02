package io.github.tinytom21.imutracker

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread

/**
 * Records accelerometer + gyroscope (+ game rotation vector) at the fastest rate and merges them
 * onto accelerometer timestamps. Samples: t(s), ax..az (m/s^2), gx..gz (rad/s), qx,qy,qz,qw.
 */
class ImuRecorder(context: Context) : SensorEventListener {

    private val sm = context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val accel: Sensor? = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyro: Sensor? = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val rot: Sensor? = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)

    private var thread: HandlerThread? = null

    @Volatile
    private var running = false

    // ---- output buffer (guarded by lock) ----
    private val lock = Any()
    private var buf = DoubleArray(FIELDS * 8192)
    private var count = 0

    // ---- merge state (touched only on the sensor thread, and by start() before registering) ----
    private var gPrevT = 0L
    private var gPrevX = 0.0
    private var gPrevY = 0.0
    private var gPrevZ = 0.0
    private var hasPrev = false
    private var gLastT = 0L
    private var gLastX = 0.0
    private var gLastY = 0.0
    private var gLastZ = 0.0
    private var hasLast = false

    private val pendT = LongArray(PENDING_MAX)
    private val pendV = DoubleArray(PENDING_MAX * 3)
    private var pendHead = 0
    private var pendSize = 0

    private val quat = FloatArray(4) // w, x, y, z
    private var hasQuat = false

    @Synchronized
    fun start(): Boolean {
        if (accel == null || gyro == null) return false
        stop()
        synchronized(lock) { count = 0 }
        hasPrev = false
        hasLast = false
        pendHead = 0
        pendSize = 0
        hasQuat = false

        val t = HandlerThread("imu-sensors").also { it.start() }
        thread = t
        val h = Handler(t.looper)
        running = true
        val okA = sm.registerListener(this, accel, SensorManager.SENSOR_DELAY_FASTEST, h)
        val okG = sm.registerListener(this, gyro, SensorManager.SENSOR_DELAY_FASTEST, h)
        if (rot != null) sm.registerListener(this, rot, SensorManager.SENSOR_DELAY_FASTEST, h)
        if (!okA || !okG) {
            stop()
            return false
        }
        return true
    }

    @Synchronized
    fun stop() {
        running = false
        try {
            sm.unregisterListener(this)
        } catch (_: Exception) {
        }
        val t = thread
        thread = null
        if (t != null) {
            t.quitSafely()
            try {
                t.join(500)
            } catch (_: InterruptedException) {
            }
        }
    }

    /** JSON array of all samples since the last drain. */
    fun drain(): String {
        val data: DoubleArray
        val n: Int
        synchronized(lock) {
            n = count
            if (n == 0) return "[]"
            data = buf.copyOf(n * FIELDS)
            count = 0
        }
        val sb = StringBuilder(n * 200 + 2)
        sb.append('[')
        for (i in 0 until n) {
            val o = i * FIELDS
            if (i > 0) sb.append(',')
            sb.append("{\"t\":").append(data[o])
            sb.append(",\"ax\":").append(data[o + 1])
            sb.append(",\"ay\":").append(data[o + 2])
            sb.append(",\"az\":").append(data[o + 3])
            sb.append(",\"gx\":").append(data[o + 4])
            sb.append(",\"gy\":").append(data[o + 5])
            sb.append(",\"gz\":").append(data[o + 6])
            val qw = data[o + 10]
            if (qw.isNaN()) {
                sb.append(",\"qx\":null,\"qy\":null,\"qz\":null,\"qw\":null")
            } else {
                sb.append(",\"qx\":").append(data[o + 7])
                sb.append(",\"qy\":").append(data[o + 8])
                sb.append(",\"qz\":").append(data[o + 9])
                sb.append(",\"qw\":").append(qw)
            }
            sb.append('}')
        }
        sb.append(']')
        return sb.toString()
    }

    fun info(): String {
        fun maxHz(s: Sensor?): Double = if (s != null && s.minDelay > 0) 1_000_000.0 / s.minDelay else 0.0
        fun name(s: Sensor?): String = s?.name ?: ""
        return "{\"accelName\":${jsonString(name(accel))},\"gyroName\":${jsonString(name(gyro))}," +
            "\"rotName\":${jsonString(name(rot))},\"accelMaxHz\":${maxHz(accel)}," +
            "\"gyroMaxHz\":${maxHz(gyro)},\"rotMaxHz\":${maxHz(rot)}," +
            "\"model\":${jsonString(android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL)}," +
            "\"androidVersion\":${jsonString(android.os.Build.VERSION.RELEASE)}}"
    }

    // ------------------------------------------------------------------ sensor callbacks

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onSensorChanged(event: SensorEvent) {
        if (!running) return
        val v = event.values
        when (event.sensor.type) {
            Sensor.TYPE_GYROSCOPE -> onGyro(event.timestamp, v[0].toDouble(), v[1].toDouble(), v[2].toDouble())
            Sensor.TYPE_ACCELEROMETER -> onAccel(event.timestamp, v[0].toDouble(), v[1].toDouble(), v[2].toDouble())
            Sensor.TYPE_GAME_ROTATION_VECTOR -> {
                SensorManager.getQuaternionFromVector(quat, v)
                hasQuat = true
            }
        }
    }

    private fun onGyro(t: Long, x: Double, y: Double, z: Double) {
        if (hasLast) {
            gPrevT = gLastT; gPrevX = gLastX; gPrevY = gLastY; gPrevZ = gLastZ
            hasPrev = true
        }
        gLastT = t; gLastX = x; gLastY = y; gLastZ = z
        hasLast = true
        flush(t)
    }

    private fun onAccel(t: Long, x: Double, y: Double, z: Double) {
        if (pendSize == PENDING_MAX) { // drop oldest
            pendHead = (pendHead + 1) % PENDING_MAX
            pendSize--
        }
        val idx = (pendHead + pendSize) % PENDING_MAX
        pendT[idx] = t
        pendV[idx * 3] = x
        pendV[idx * 3 + 1] = y
        pendV[idx * 3 + 2] = z
        pendSize++
        flush(t)
    }

    /** Emits queued accel events whose bracketing gyro has arrived (or that waited > 20 ms). */
    private fun flush(nowNs: Long) {
        while (pendSize > 0) {
            val t = pendT[pendHead]
            val covered = hasLast && t <= gLastT
            val stale = nowNs - t > STALE_NS
            if (!covered && !stale) return
            val i = pendHead
            pendHead = (pendHead + 1) % PENDING_MAX
            pendSize--
            if (!hasLast) continue // no gyro reading at all yet: drop
            var gx = gLastX
            var gy = gLastY
            var gz = gLastZ
            if (hasPrev && t < gLastT && gLastT > gPrevT) {
                var f = (t - gPrevT).toDouble() / (gLastT - gPrevT).toDouble()
                if (f < 0.0) f = 0.0
                if (f > 1.0) f = 1.0
                gx = gPrevX + (gLastX - gPrevX) * f
                gy = gPrevY + (gLastY - gPrevY) * f
                gz = gPrevZ + (gLastZ - gPrevZ) * f
            }
            append(t, pendV[i * 3], pendV[i * 3 + 1], pendV[i * 3 + 2], gx, gy, gz)
        }
    }

    private fun append(tNs: Long, ax: Double, ay: Double, az: Double, gx: Double, gy: Double, gz: Double) {
        synchronized(lock) {
            if ((count + 1) * FIELDS > buf.size) buf = buf.copyOf(buf.size * 2)
            val o = count * FIELDS
            buf[o] = tNs / 1e9
            buf[o + 1] = ax
            buf[o + 2] = ay
            buf[o + 3] = az
            buf[o + 4] = gx
            buf[o + 5] = gy
            buf[o + 6] = gz
            if (hasQuat) {
                buf[o + 7] = quat[1].toDouble() // qx
                buf[o + 8] = quat[2].toDouble() // qy
                buf[o + 9] = quat[3].toDouble() // qz
                buf[o + 10] = quat[0].toDouble() // qw
            } else {
                buf[o + 7] = Double.NaN
                buf[o + 8] = Double.NaN
                buf[o + 9] = Double.NaN
                buf[o + 10] = Double.NaN
            }
            count++
        }
    }

    companion object {
        private const val FIELDS = 11
        private const val PENDING_MAX = 512
        private const val STALE_NS = 20_000_000L

        fun jsonString(s: String): String {
            val sb = StringBuilder("\"")
            for (c in s) {
                when {
                    c == '"' -> sb.append("\\\"")
                    c == '\\' -> sb.append("\\\\")
                    c.code < 0x20 -> sb.append(String.format("\\u%04x", c.code))
                    else -> sb.append(c)
                }
            }
            return sb.append('"').toString()
        }
    }
}
