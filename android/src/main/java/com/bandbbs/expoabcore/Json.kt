package com.bandbbs.expoabcore

import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.toMap(): Map<String, Any?> = keys().asSequence().associateWith { key ->
  when (val value = opt(key)) {
    JSONObject.NULL -> null
    is JSONObject -> value.toMap()
    is JSONArray -> value.toListValue()
    else -> value
  }
}

internal fun JSONArray.toListValue(): List<Any?> = (0 until length()).map { index ->
  when (val value = opt(index)) {
    JSONObject.NULL -> null
    is JSONObject -> value.toMap()
    is JSONArray -> value.toListValue()
    else -> value
  }
}

internal fun mapToJson(value: Map<String, Any?>): JSONObject = JSONObject().apply {
  value.forEach { (key, item) -> put(key, jsonValue(item)) }
}

private fun jsonValue(value: Any?): Any? = when (value) {
  null -> JSONObject.NULL
  is Map<*, *> -> JSONObject().apply {
    value.forEach { (key, item) -> if (key is String) put(key, jsonValue(item)) }
  }
  is Iterable<*> -> JSONArray().apply { value.forEach { put(jsonValue(it)) } }
  is Array<*> -> JSONArray().apply { value.forEach { put(jsonValue(it)) } }
  else -> value
}
