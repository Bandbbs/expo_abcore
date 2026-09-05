package com.bandbbs.expoabcore

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Keeps the Bluetooth session visible while the host is in the background. */
class ConnectionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) { stopSelf(); return START_NOT_STICKY }
    val manager = getSystemService(NotificationManager::class.java)
    val channelName = intent.getStringExtra("channelName") ?: "Connected device"
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, channelName, NotificationManager.IMPORTANCE_LOW))
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(Intent.ACTION_VIEW)
    launch.action = Intent.ACTION_VIEW
    launch.data = Uri.parse(intent.getStringExtra("url") ?: "")
    launch.setPackage(packageName)
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pending = PendingIntent.getActivity(this, ID, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setContentTitle(intent.getStringExtra("name") ?: channelName)
      .setContentText(intent.getStringExtra("status") ?: "Connected")
      .setContentIntent(pending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
    ServiceCompat.startForeground(this, ID, notification,
      if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "expo_abcore_connection"
    private const val ID = 0xAB01
    fun show(context: Context, name: String, status: String, url: String, channelName: String) {
      ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java)
        .putExtra("name", name).putExtra("status", status).putExtra("url", url).putExtra("channelName", channelName))
    }
    fun hide(context: Context) { context.stopService(Intent(context, ConnectionService::class.java)) }
  }
}
