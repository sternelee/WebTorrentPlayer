package com.sternelee.torplay

import android.Manifest
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Bundle
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var rustWebView: RustWebView? = null
  private lateinit var connectivityManager: ConnectivityManager
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    registerNetworkCallback()
  }

  override fun onDestroy() {
    unregisterNetworkCallback()
    rustWebView = null
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    val tauriWebView = webView as? RustWebView ?: return
    rustWebView = tauriWebView
    tauriWebView.addJavascriptInterface(AndroidBridge(), "WebTorrentPlayerAndroid")
  }

  private fun registerNetworkCallback() {
    if (networkCallback != null) {
      return
    }

    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = emitCurrentNetworkStatus()

      override fun onLost(network: Network) = emitCurrentNetworkStatus()

      override fun onCapabilitiesChanged(
        network: Network,
        networkCapabilities: NetworkCapabilities,
      ) = emitCurrentNetworkStatus()

      override fun onUnavailable() = emitCurrentNetworkStatus()
    }

    networkCallback = callback

    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        connectivityManager.registerDefaultNetworkCallback(callback)
      } else {
        connectivityManager.registerNetworkCallback(NetworkRequest.Builder().build(), callback)
      }
    }
  }

  private fun unregisterNetworkCallback() {
    val callback = networkCallback ?: return
    runCatching {
      connectivityManager.unregisterNetworkCallback(callback)
    }
    networkCallback = null
  }

  private fun currentNetworkStatusJson(): JSONObject {
    val activeNetwork = connectivityManager.activeNetwork
    val capabilities = activeNetwork?.let(connectivityManager::getNetworkCapabilities)

    val transports = JSONArray()
    if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) {
      transports.put("wifi")
    }
    if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true) {
      transports.put("cellular")
    }
    if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true) {
      transports.put("ethernet")
    }
    if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true) {
      transports.put("vpn")
    }

    return JSONObject().apply {
      put("connected", activeNetwork != null && capabilities != null)
      put(
        "validated",
        capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
      )
      put(
        "internetCapable",
        capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
      )
      put("metered", connectivityManager.isActiveNetworkMetered)
      put("transports", transports)
    }
  }

  private fun emitCurrentNetworkStatus() {
    emitToFrontend(
      "torplay:android-network-change",
      currentNetworkStatusJson().toString(),
    )
  }

  private fun emitToFrontend(eventName: String, payloadJson: String) {
    val webView = rustWebView ?: return
    val script =
      """
      window.dispatchEvent(new CustomEvent(${JSONObject.quote(eventName)}, { detail: $payloadJson }));
      """.trimIndent()

    webView.post {
      webView.evaluateJavascript(script, null)
    }
  }

  private fun ensureNotificationPermission() {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(
        this,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        1001,
      )
    }
  }

  inner class AndroidBridge {
    @JavascriptInterface
    fun upsertForegroundSession(payloadJson: String) {
      ensureNotificationPermission()
      PlaybackForegroundService.upsert(this@MainActivity, payloadJson)
    }

    @JavascriptInterface
    fun stopForegroundSession() {
      PlaybackForegroundService.stop(this@MainActivity)
    }

    @JavascriptInterface
    fun getNetworkStatus(): String = currentNetworkStatusJson().toString()

    @JavascriptInterface
    fun enterLandscapeFullscreen() {
      runOnUiThread {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      }
    }

    @JavascriptInterface
    fun exitLandscapeFullscreen() {
      runOnUiThread {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
      }
    }
  }
}
