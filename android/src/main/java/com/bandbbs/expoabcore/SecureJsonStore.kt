package com.bandbbs.expoabcore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class SecureJsonStore(context: Context) {
  private val preferences = context.getSharedPreferences(
    "expo_abcore_secure_store",
    Context.MODE_PRIVATE,
  )

  fun get(key: String, fallback: String): String {
    val encoded = preferences.getString(key, null) ?: return fallback
    return runCatching { decrypt(encoded) }.getOrDefault(fallback)
  }

  fun set(key: String, value: String) {
    preferences.edit().putString(key, encrypt(value)).apply()
  }

  private fun encrypt(value: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP)
  }

  private fun decrypt(encoded: String): String {
    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
    require(bytes.size > IV_BYTES) { "Invalid encrypted payload" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      secretKey(),
      GCMParameterSpec(128, bytes.copyOfRange(0, IV_BYTES)),
    )
    return String(cipher.doFinal(bytes.copyOfRange(IV_BYTES, bytes.size)), Charsets.UTF_8)
  }

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(
          KEY_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .build(),
      )
      generateKey()
    }
  }

  private companion object {
    const val KEY_ALIAS = "expo_abcore_profiles_v1"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
