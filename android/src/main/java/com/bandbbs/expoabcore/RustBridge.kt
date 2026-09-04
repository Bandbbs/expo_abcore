package com.bandbbs.expoabcore

import androidx.annotation.Keep
import expo.modules.kotlin.exception.CodedException
import org.json.JSONObject

internal class RustBridge(private val callbacks: Callbacks) {
  interface Callbacks {
    fun send(data: ByteArray): Int
    fun event(name: String, payload: JSONObject)
  }

  init {
    System.loadLibrary("expo_abcore")
    check(nativeInit() == 0) { "Failed to initialize expo-abcore Rust bridge" }
  }

  external fun nativeInit(): Int
  external fun nativeDestroy()
  external fun nativeCall(command: String, input: String): String
  external fun nativeOnPacket(kind: String, address: String, data: ByteArray): Int

  fun call(command: String, input: JSONObject = JSONObject()): Any? {
    val response = JSONObject(nativeCall(command, input.toString()))
    if (!response.optBoolean("ok")) {
      val error = response.optJSONObject("error")
      throw ExpoABCoreException(
        error?.optString("code")?.ifEmpty { null } ?: "NATIVE_ERROR",
        error?.optString("message")?.ifEmpty { null } ?: "Native operation failed",
      )
    }
    return response.opt("data").takeUnless { it == JSONObject.NULL }
  }

  fun close() {
    nativeDestroy()
  }

  @Keep
  fun onRustSend(data: ByteArray): Int = callbacks.send(data)

  @Keep
  fun onRustEvent(name: String, payload: String) {
    callbacks.event(name, JSONObject(payload))
  }
}

internal class ExpoABCoreException(
  code: String,
  message: String,
) : CodedException(code, message, null)
