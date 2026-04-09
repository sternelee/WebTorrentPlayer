package com.sternelee.webtorrentplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt
import org.json.JSONObject

class PlaybackForegroundService : Service() {
  private val notificationManager by lazy {
    getSystemService(NotificationManager::class.java)
  }
  private var foregroundStarted = false

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_UPSERT -> {
        val payload = intent.getStringExtra(EXTRA_PAYLOAD)
        val session = payload?.let(NotificationSession::fromJson)
        if (session == null) {
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf()
          return START_NOT_STICKY
        }

        val notification = buildNotification(session)
        if (!foregroundStarted) {
          foregroundStarted = true
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
              NOTIFICATION_ID,
              notification,
              ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
          } else {
            startForeground(NOTIFICATION_ID, notification)
          }
        } else {
          notificationManager.notify(NOTIFICATION_ID, notification)
        }
      }
    }

    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    foregroundStarted = false
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }

    val channel =
      NotificationChannel(
        CHANNEL_ID,
        getString(R.string.foreground_channel_name),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = getString(R.string.foreground_channel_description)
        setShowBadge(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }

    notificationManager.createNotificationChannel(channel)
  }

  private fun buildNotification(session: NotificationSession): Notification {
    val launchIntent =
      packageManager.getLaunchIntentForPackage(packageName)?.apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      } ?: Intent(this, MainActivity::class.java)

    val pendingIntent =
      PendingIntent.getActivity(
        this,
        0,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or pendingIntentImmutableFlag(),
      )

    val stateLabel =
      when (session.state) {
        "paused" -> "已暂停"
        "seeding" -> "做种中"
        "downloading" -> if (session.isPlaying) "后台播放中" else "后台下载中"
        "parsing" -> "解析中"
        else -> "运行中"
      }

    val summary =
      buildString {
        append(stateLabel)
        append(" · ")
        append("${session.progressPercent.roundToInt()}%")
        append(" · ↓ ")
        append(formatSpeed(session.downloadSpeedKbps))
        append(" · ")
        append(session.peersConnected)
        append(" peers")
      }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(session.title.ifBlank { "WebTorrentPlayer" })
      .setContentText(summary)
      .setStyle(
        NotificationCompat.BigTextStyle().bigText(
          buildString {
            append(summary)
            append('\n')
            append("↑ ")
            append(formatSpeed(session.uploadSpeedKbps))
            append(" · ")
            append(if (session.isPlaying) "播放器已挂接本地流" else "继续维持本地 BT 会话")
          },
        ),
      )
      .setContentIntent(pendingIntent)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .build()
  }

  private fun formatSpeed(kbps: Double): String {
    return if (kbps >= 1024.0) {
      String.format("%.1f MB/s", kbps / 1024.0)
    } else {
      String.format("%.1f KB/s", kbps)
    }
  }

  private fun pendingIntentImmutableFlag(): Int {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_IMMUTABLE
    } else {
      0
    }
  }

  private data class NotificationSession(
    val title: String,
    val state: String,
    val progressPercent: Double,
    val downloadSpeedKbps: Double,
    val uploadSpeedKbps: Double,
    val peersConnected: Int,
    val isPlaying: Boolean,
  ) {
    companion object {
      fun fromJson(payloadJson: String): NotificationSession? {
        return runCatching {
          val payload = JSONObject(payloadJson)
          NotificationSession(
            title = payload.optString("title"),
            state = payload.optString("state", "parsing"),
            progressPercent = payload.optDouble("progressPercent", 0.0),
            downloadSpeedKbps = payload.optDouble("downloadSpeedKbps", 0.0),
            uploadSpeedKbps = payload.optDouble("uploadSpeedKbps", 0.0),
            peersConnected = payload.optInt("peersConnected", 0),
            isPlaying = payload.optBoolean("isPlaying", false),
          )
        }.getOrNull()
      }
    }
  }

  companion object {
    private const val CHANNEL_ID = "torplay-playback"
    private const val NOTIFICATION_ID = 1001
    private const val ACTION_UPSERT = "com.sternelee.webtorrentplayer.action.UPSERT_FOREGROUND"
    private const val EXTRA_PAYLOAD = "payload"

    fun upsert(context: Context, payloadJson: String) {
      val intent =
        Intent(context, PlaybackForegroundService::class.java).apply {
          action = ACTION_UPSERT
          putExtra(EXTRA_PAYLOAD, payloadJson)
        }
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, PlaybackForegroundService::class.java))
    }
  }
}
