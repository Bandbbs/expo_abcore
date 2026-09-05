// Adapted from MiFitnessLogReader. Copyright (c) 2026 AstralSight Studios.
// SPDX-License-Identifier: MIT
// See licenses/MiFitnessLogReader-MIT.txt.
use std::{collections::HashSet, fs, io::Read, path::Path};

use nskeyedarchiver_converter::Converter;
use serde_json::Value as JsonValue;
use zip::ZipArchive;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum Platform {
    Android,
    Ios,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct DeviceInfo {
    pub name: String,
    pub encrypt_key: String,
    pub platform: Platform,
}

const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;

pub fn extract(path: &Path, platform: &str) -> Result<Vec<DeviceInfo>, String> {
    let size = fs::metadata(path)
        .map_err(|_| "Unable to read selected file")?
        .len();
    if size > MAX_INPUT_BYTES {
        return Err("Selected file exceeds 64 MiB".into());
    }
    match platform {
        "android" => parse_android_zip(path),
        "ios" => parse_ios_sqlite(path),
        _ => Err("Unsupported log platform".into()),
    }
}

pub fn parse_android_zip(path: &Path) -> Result<Vec<DeviceInfo>, String> {
    let file = fs::File::open(path).map_err(|_| "Unable to open log archive")?;
    let mut archive = ZipArchive::new(file).map_err(|_| "Invalid log ZIP")?;
    if archive.len() > 4096 {
        return Err("Too many archive entries".into());
    }
    let mut pairs = Vec::new();
    let mut remaining = MAX_INPUT_BYTES;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| "Invalid ZIP entry")?;
        if Path::new(entry.name()).file_name().and_then(|n| n.to_str())
            != Some("XiaomiFit.main.log")
        {
            continue;
        }
        if entry.size() > remaining {
            return Err("Log exceeds 64 MiB".into());
        }
        let mut text = String::new();
        entry
            .take(remaining + 1)
            .read_to_string(&mut text)
            .map_err(|_| "Unable to read log text")?;
        if text.len() as u64 > remaining {
            return Err("Log exceeds 64 MiB".into());
        }
        remaining -= text.len() as u64;
        pairs.extend(parse_android_log_text(&text));
    }
    pairs.sort_by(|a, b| a.name.cmp(&b.name).then(a.encrypt_key.cmp(&b.encrypt_key)));
    pairs.dedup();
    if pairs.is_empty() {
        return Err("No device keys found in XiaomiFit.main.log".into());
    }
    Ok(pairs)
}

pub fn parse_ios_sqlite(sqlite_path: &Path) -> Result<Vec<DeviceInfo>, String> {
    if !sqlite_path.exists() {
        return Err(format!("找不到 sqlite 文件: {}", sqlite_path.display()));
    }

    let sqlite_bytes = fs::read(sqlite_path)
        .map_err(|e| format!("读取 sqlite 失败 ({}): {}", sqlite_path.display(), e))?;

    let sqlite = SqliteFile::parse(sqlite_bytes)?;
    let manifest_root_page = sqlite.find_table_root_page("manifest")?;
    let manifest_rows = sqlite.read_table_rows(manifest_root_page)?;
    let inline_data = manifest_rows
        .iter()
        .find_map(|row| {
            let key = row.first().and_then(SqliteCellValue::as_text)?;
            if key == "registerList_cn" {
                row.get(3)
                    .and_then(SqliteCellValue::as_blob)
                    .map(|b| b.to_vec())
            } else {
                None
            }
        })
        .ok_or_else(|| "sqlite 中未找到 key=registerList_cn 的 inline_data".to_string())?;

    let archive =
        nskeyedarchiver_converter::plist::Value::from_reader(std::io::Cursor::new(&inline_data))
            .map_err(|_| "Invalid NSKeyedArchiver plist")?;
    validate_archive(&archive)?;
    let mut converter = Converter::new(archive).map_err(|_| "Invalid NSKeyedArchiver structure")?;
    let decoded = converter
        .decode()
        .map_err(|e| format!("解码 NSKeyedArchiver 失败: {}", e))?;

    let mut raw_pairs = Vec::<(String, String)>::new();
    collect_pairs_from_plist(&decoded, &mut Vec::new(), &mut raw_pairs);
    let devices = dedup_pairs(raw_pairs, Platform::Ios);
    if devices.is_empty() {
        return Err("iOS 数据中未找到有效的设备 encryptKey 信息".to_string());
    }

    Ok(devices)
}

fn validate_archive(archive: &nskeyedarchiver_converter::plist::Value) -> Result<(), String> {
    use nskeyedarchiver_converter::plist::Value;
    let root = archive.as_dictionary().ok_or("Invalid archive root")?;
    let objects = root
        .get("$objects")
        .and_then(Value::as_array)
        .ok_or("Missing archive objects")?;
    let top = root.get("$top").ok_or("Missing archive root reference")?;
    fn walk(
        value: &Value,
        objects: &[Value],
        stack: &mut HashSet<u64>,
        budget: &mut usize,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 64 || *budget == 0 {
            return Err("Archive is too complex".into());
        }
        *budget -= 1;
        match value {
            Value::Uid(uid) => {
                let index = uid.get();
                if !stack.insert(index) {
                    return Err("Cyclic archive reference".into());
                }
                let target = objects
                    .get(usize::try_from(index).map_err(|_| "Invalid archive reference")?)
                    .ok_or("Invalid archive reference")?;
                walk(target, objects, stack, budget, depth + 1)?;
                stack.remove(&index);
            }
            Value::Dictionary(map) => {
                if let Some(keys) = map.get("NS.keys").and_then(Value::as_array) {
                    if map
                        .get("NS.objects")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        != Some(keys.len())
                    {
                        return Err("Mismatched archive dictionary entries".into());
                    }
                }
                for item in map.values() {
                    walk(item, objects, stack, budget, depth + 1)?;
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, objects, stack, budget, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(top, objects, &mut HashSet::new(), &mut 100_000, 0)
}

fn parse_android_log_text(log_text: &str) -> Vec<DeviceInfo> {
    let mut raw_pairs = Vec::<(String, String)>::new();
    for object_text in iter_json_objects(log_text) {
        let parsed = serde_json::from_str::<JsonValue>(&object_text);
        let Ok(json) = parsed else {
            continue;
        };
        collect_pairs_from_json(&json, &mut Vec::new(), &mut raw_pairs);
    }
    dedup_pairs(raw_pairs, Platform::Android)
}

fn dedup_pairs(raw_pairs: Vec<(String, String)>, platform: Platform) -> Vec<DeviceInfo> {
    let mut seen = HashSet::<(String, String)>::new();
    let mut out = Vec::<DeviceInfo>::new();

    for (name, encrypt_key) in raw_pairs {
        let normalized_name = normalize_name(&name).unwrap_or_else(|| "未知设备".to_string());
        let normalized_key = encrypt_key.to_ascii_lowercase();
        if !is_hex_32(&normalized_key) {
            continue;
        }

        if seen.insert((normalized_name.clone(), normalized_key.clone())) {
            out.push(DeviceInfo {
                name: normalized_name,
                encrypt_key: normalized_key,
                platform,
            });
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.encrypt_key.cmp(&b.encrypt_key)));
    out
}

fn collect_pairs_from_json(
    value: &JsonValue,
    ancestor_names: &mut Vec<Option<String>>,
    out: &mut Vec<(String, String)>,
) {
    match value {
        JsonValue::Object(map) => {
            let this_name = extract_name_from_json_map(map);

            if let Some(encrypt_key) = extract_encrypt_key_from_json_map(map) {
                let name = this_name
                    .clone()
                    .or_else(|| nearest_name(ancestor_names))
                    .unwrap_or_else(|| "未知设备".to_string());
                out.push((name, encrypt_key));
            }

            ancestor_names.push(this_name);
            for child in map.values() {
                collect_pairs_from_json(child, ancestor_names, out);
            }
            ancestor_names.pop();
        }
        JsonValue::Array(items) => {
            for child in items {
                collect_pairs_from_json(child, ancestor_names, out);
            }
        }
        _ => {}
    }
}

fn collect_pairs_from_plist(
    value: &nskeyedarchiver_converter::plist::Value,
    ancestor_names: &mut Vec<Option<String>>,
    out: &mut Vec<(String, String)>,
) {
    use nskeyedarchiver_converter::plist::Value;

    match value {
        Value::Dictionary(map) => {
            let this_name = extract_name_from_plist_map(map);
            if let Some(encrypt_key) = extract_encrypt_key_from_plist_map(map) {
                let name = this_name
                    .clone()
                    .or_else(|| nearest_name(ancestor_names))
                    .unwrap_or_else(|| "未知设备".to_string());
                out.push((name, encrypt_key));
            }

            ancestor_names.push(this_name);
            for child in map.values() {
                collect_pairs_from_plist(child, ancestor_names, out);
            }
            ancestor_names.pop();
        }
        Value::Array(items) => {
            // The converter represents NSDictionary as [{key, value}, ...].
            let entries: Option<nskeyedarchiver_converter::plist::Dictionary> = items
                .iter()
                .map(|item| {
                    let pair = item.as_dictionary()?;
                    Some((
                        pair.get("key")?.as_string()?.to_string(),
                        pair.get("value")?.clone(),
                    ))
                })
                .collect();
            if let Some(map) = entries.filter(|map| !map.is_empty()) {
                collect_pairs_from_plist(&Value::Dictionary(map), ancestor_names, out);
                return;
            }
            for child in items {
                collect_pairs_from_plist(child, ancestor_names, out);
            }
        }
        _ => {}
    }
}

fn nearest_name(ancestor_names: &[Option<String>]) -> Option<String> {
    ancestor_names.iter().rev().find_map(|n| n.clone())
}

fn extract_encrypt_key_from_json_map(map: &serde_json::Map<String, JsonValue>) -> Option<String> {
    for key in ["encryptKey", "encrypt_key", "encryptkey"] {
        if let Some(candidate) = map.get(key).and_then(|v| v.as_str()) {
            if is_hex_32(candidate) {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn extract_name_from_json_map(map: &serde_json::Map<String, JsonValue>) -> Option<String> {
    for key in [
        "name",
        "deviceName",
        "device_name",
        "productName",
        "product_name",
        "bltNamePrefix",
    ] {
        if let Some(raw) = map.get(key).and_then(|v| v.as_str()) {
            if let Some(normalized) = normalize_name(raw) {
                return Some(normalized);
            }
        }
    }
    None
}

fn extract_encrypt_key_from_plist_map(
    map: &nskeyedarchiver_converter::plist::Dictionary,
) -> Option<String> {
    use nskeyedarchiver_converter::plist::Value;

    for key in ["encryptKey", "encrypt_key", "encryptkey"] {
        if let Some(Value::String(candidate)) = map.get(key) {
            if is_hex_32(candidate) {
                return Some(candidate.clone());
            }
        }
    }
    None
}

fn extract_name_from_plist_map(
    map: &nskeyedarchiver_converter::plist::Dictionary,
) -> Option<String> {
    use nskeyedarchiver_converter::plist::Value;

    for key in [
        "name",
        "deviceName",
        "device_name",
        "productName",
        "product_name",
        "bltNamePrefix",
    ] {
        let Some(Value::String(raw)) = map.get(key) else {
            continue;
        };
        if let Some(normalized) = normalize_name(raw) {
            return Some(normalized);
        }
    }
    None
}

fn normalize_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "$null" {
        return None;
    }
    Some(trimmed.to_string())
}

fn is_hex_32(s: &str) -> bool {
    s.len() == 32 && s.as_bytes().iter().all(u8::is_ascii_hexdigit)
}

fn iter_json_objects(input: &str) -> Vec<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start: Option<usize> = None;
    let mut in_string = false;
    let mut escaped = false;

    for (idx, &byte) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        match byte {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = Some(idx);
                }
                depth = depth.saturating_add(1);
            }
            b'}' => {
                if depth == 0 {
                    continue;
                }
                depth -= 1;
                if depth == 0 {
                    if let Some(begin) = start.take() {
                        out.push(input[begin..=idx].to_string());
                    }
                }
            }
            _ => {}
        }
    }

    out
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
enum SqliteCellValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl SqliteCellValue {
    fn as_text(&self) -> Option<&str> {
        match self {
            SqliteCellValue::Text(v) => Some(v.as_str()),
            _ => None,
        }
    }

    fn as_blob(&self) -> Option<&[u8]> {
        match self {
            SqliteCellValue::Blob(v) => Some(v.as_slice()),
            _ => None,
        }
    }

    fn as_integer(&self) -> Option<i64> {
        match self {
            SqliteCellValue::Integer(v) => Some(*v),
            _ => None,
        }
    }
}

struct SqliteFile {
    bytes: Vec<u8>,
    page_size: usize,
    usable_size: usize,
}

#[derive(Clone, Copy)]
struct PageHeader {
    page_type: u8,
    cell_count: u16,
    cell_pointer_array_offset: usize,
    right_most_pointer: Option<u32>,
}

impl SqliteFile {
    fn parse(bytes: Vec<u8>) -> Result<Self, String> {
        if bytes.len() < 100 {
            return Err("sqlite 文件过小，不是有效 SQLite 文件".to_string());
        }
        if &bytes[0..16] != b"SQLite format 3\0" {
            return Err("文件头不是 SQLite format 3".to_string());
        }

        let page_size_raw = u16::from_be_bytes([bytes[16], bytes[17]]);
        let page_size = if page_size_raw == 1 {
            65536usize
        } else {
            page_size_raw as usize
        };
        let reserved_bytes = bytes[20] as usize;
        if !(512..=65536).contains(&page_size)
            || !page_size.is_power_of_two()
            || page_size <= reserved_bytes + 480
        {
            return Err("SQLite 页大小异常".to_string());
        }

        Ok(Self {
            bytes,
            page_size,
            usable_size: page_size - reserved_bytes,
        })
    }

    fn find_table_root_page(&self, table_name: &str) -> Result<u32, String> {
        let rows = self.read_table_rows(1)?;
        for row in rows {
            let Some(object_type) = row.first().and_then(SqliteCellValue::as_text) else {
                continue;
            };
            let Some(name) = row.get(1).and_then(SqliteCellValue::as_text) else {
                continue;
            };
            if object_type == "table" && name == table_name {
                let Some(root_page) = row.get(3).and_then(SqliteCellValue::as_integer) else {
                    continue;
                };
                if root_page <= 0 {
                    continue;
                }
                return Ok(root_page as u32);
            }
        }
        Err(format!("未在 sqlite_master 中找到表 {}", table_name))
    }

    fn read_table_rows(&self, root_page: u32) -> Result<Vec<Vec<SqliteCellValue>>, String> {
        let mut rows = Vec::new();
        self.walk_table_btree(root_page, &mut rows, &mut HashSet::new(), 0)?;
        Ok(rows)
    }

    fn walk_table_btree(
        &self,
        page_no: u32,
        out_rows: &mut Vec<Vec<SqliteCellValue>>,
        visited: &mut HashSet<u32>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 64 || !visited.insert(page_no) {
            return Err("Invalid cyclic or deep SQLite tree".into());
        }
        let page = self.page_data(page_no)?;
        let header = self.page_header(page_no)?;

        match header.page_type {
            0x0D => {
                for cell_index in 0..header.cell_count {
                    let ptr_offset = header.cell_pointer_array_offset + (cell_index as usize * 2);
                    let cell_offset = read_u16(page, ptr_offset)? as usize;
                    let row = self.parse_table_leaf_cell(page_no, cell_offset)?;
                    out_rows.push(row);
                }
            }
            0x05 => {
                for cell_index in 0..header.cell_count {
                    let ptr_offset = header.cell_pointer_array_offset + (cell_index as usize * 2);
                    let cell_offset = read_u16(page, ptr_offset)? as usize;
                    if cell_offset + 4 > page.len() {
                        return Err(format!(
                            "页 {} 内部节点 cell 偏移越界 (offset={})",
                            page_no, cell_offset
                        ));
                    }
                    let child_page = read_u32(page, cell_offset)?;
                    self.walk_table_btree(child_page, out_rows, visited, depth + 1)?;
                }
                if let Some(right_page) = header.right_most_pointer {
                    self.walk_table_btree(right_page, out_rows, visited, depth + 1)?;
                }
            }
            other => {
                return Err(format!(
                    "不支持的表 B-Tree 页类型 {:02X} (page={})",
                    other, page_no
                ));
            }
        }

        Ok(())
    }

    fn parse_table_leaf_cell(
        &self,
        page_no: u32,
        cell_offset: usize,
    ) -> Result<Vec<SqliteCellValue>, String> {
        let page = self.page_data(page_no)?;
        if cell_offset >= page.len() {
            return Err(format!(
                "页 {} 叶子节点 cell 偏移越界 (offset={})",
                page_no, cell_offset
            ));
        }

        let (payload_size, payload_varint_len) = read_varint(page, cell_offset)?;
        let (_, rowid_varint_len) = read_varint(page, cell_offset + payload_varint_len)?;

        if payload_size > MAX_INPUT_BYTES || payload_size > self.bytes.len() as u64 {
            return Err("Invalid SQLite payload size".into());
        }
        let payload_size = payload_size as usize;
        let payload_start = cell_offset + payload_varint_len + rowid_varint_len;
        let local_payload_size = self.local_payload_size(payload_size);

        if payload_start + local_payload_size > page.len() {
            return Err(format!(
                "页 {} payload 越界 (start={}, local={}, page_len={})",
                page_no,
                payload_start,
                local_payload_size,
                page.len()
            ));
        }

        let mut payload = Vec::with_capacity(payload_size);
        payload.extend_from_slice(&page[payload_start..payload_start + local_payload_size]);

        if payload_size > local_payload_size {
            let overflow_ptr_pos = payload_start + local_payload_size;
            if overflow_ptr_pos + 4 > page.len() {
                return Err(format!(
                    "页 {} overflow 指针越界 (ptr_pos={})",
                    page_no, overflow_ptr_pos
                ));
            }
            let overflow_first_page = read_u32(page, overflow_ptr_pos)?;
            let remaining = payload_size - local_payload_size;
            let overflow_payload = self.read_overflow_chain(overflow_first_page, remaining)?;
            payload.extend_from_slice(&overflow_payload);
        }

        if payload.len() != payload_size {
            return Err(format!(
                "payload 长度不一致，expected={}, actual={}",
                payload_size,
                payload.len()
            ));
        }

        parse_sqlite_record(&payload)
    }

    fn read_overflow_chain(
        &self,
        mut page_no: u32,
        mut remaining: usize,
    ) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(remaining);
        let mut visited = HashSet::new();
        while remaining > 0 {
            if !visited.insert(page_no) {
                return Err("Cyclic SQLite overflow chain".into());
            }
            if page_no == 0 {
                return Err("overflow 链提前结束".to_string());
            }
            let page = self.page_data(page_no)?;
            if page.len() < 4 {
                return Err(format!("overflow 页 {} 长度异常", page_no));
            }

            let next_page = read_u32(page, 0)?;
            let max_chunk = self.usable_size.saturating_sub(4);
            if max_chunk == 0 {
                return Err("usable_size 异常，无法读取 overflow".to_string());
            }
            let chunk = remaining.min(max_chunk);
            if 4 + chunk > page.len() {
                return Err(format!(
                    "overflow 页 {} 数据越界 (chunk={}, page_len={})",
                    page_no,
                    chunk,
                    page.len()
                ));
            }
            out.extend_from_slice(&page[4..4 + chunk]);
            remaining -= chunk;
            page_no = next_page;
        }
        Ok(out)
    }

    fn local_payload_size(&self, payload_size: usize) -> usize {
        let max_local = self.usable_size - 35;
        let min_local = ((self.usable_size - 12) * 32 / 255) - 23;
        if payload_size <= max_local {
            return payload_size;
        }

        let mut local = min_local + ((payload_size - min_local) % (self.usable_size - 4));
        if local > max_local {
            local = min_local;
        }
        local
    }

    fn page_data(&self, page_no: u32) -> Result<&[u8], String> {
        if page_no == 0 || u64::from(page_no) > (self.bytes.len() / self.page_size) as u64 {
            return Err("SQLite page is out of bounds".to_string());
        }
        let start = (page_no as usize - 1) * self.page_size;
        let end = start + self.page_size;
        if end > self.bytes.len() {
            return Err(format!(
                "页号越界 (page={}, page_size={}, file_len={})",
                page_no,
                self.page_size,
                self.bytes.len()
            ));
        }
        Ok(&self.bytes[start..end])
    }

    fn page_header(&self, page_no: u32) -> Result<PageHeader, String> {
        let page = self.page_data(page_no)?;
        let base = if page_no == 1 { 100 } else { 0 };
        if page.len() < base + 8 {
            return Err(format!("页头长度不足 (page={})", page_no));
        }

        let page_type = page[base];
        let cell_count = read_u16(page, base + 3)?;
        let header_len = match page_type {
            0x05 | 0x02 => 12usize,
            0x0D | 0x0A => 8usize,
            _ => {
                return Err(format!(
                    "未知 B-Tree 页类型 {:02X} (page={})",
                    page_type, page_no
                ));
            }
        };

        let right_most_pointer = if matches!(page_type, 0x05 | 0x02) {
            Some(read_u32(page, base + 8)?)
        } else {
            None
        };

        Ok(PageHeader {
            page_type,
            cell_count,
            cell_pointer_array_offset: base + header_len,
            right_most_pointer,
        })
    }
}

fn parse_sqlite_record(payload: &[u8]) -> Result<Vec<SqliteCellValue>, String> {
    let (header_size_raw, header_varint_len) = read_varint(payload, 0)?;
    let header_size = usize::try_from(header_size_raw).map_err(|_| "Invalid SQLite header size")?;
    if header_size > payload.len() || header_size < header_varint_len {
        return Err("SQLite 记录头大小非法".to_string());
    }

    let mut serial_types = Vec::new();
    let mut cursor = header_varint_len;
    while cursor < header_size {
        let (serial, consumed) = read_varint(payload, cursor)?;
        serial_types.push(serial);
        cursor += consumed;
    }

    let mut data_cursor = header_size;
    let mut values = Vec::with_capacity(serial_types.len());
    for serial in serial_types {
        let (value, consumed) = parse_sqlite_serial_type(serial, &payload[data_cursor..])?;
        data_cursor += consumed;
        values.push(value);
    }

    Ok(values)
}

fn parse_sqlite_serial_type(
    serial_type: u64,
    data: &[u8],
) -> Result<(SqliteCellValue, usize), String> {
    match serial_type {
        0 => Ok((SqliteCellValue::Null, 0)),
        1 => read_signed(data, 1).map(|v| (SqliteCellValue::Integer(v), 1)),
        2 => read_signed(data, 2).map(|v| (SqliteCellValue::Integer(v), 2)),
        3 => read_signed(data, 3).map(|v| (SqliteCellValue::Integer(v), 3)),
        4 => read_signed(data, 4).map(|v| (SqliteCellValue::Integer(v), 4)),
        5 => read_signed(data, 6).map(|v| (SqliteCellValue::Integer(v), 6)),
        6 => read_signed(data, 8).map(|v| (SqliteCellValue::Integer(v), 8)),
        7 => {
            if data.len() < 8 {
                return Err("REAL 数据越界".to_string());
            }
            let raw = u64::from_be_bytes(data[0..8].try_into().unwrap_or_default());
            Ok((SqliteCellValue::Real(f64::from_bits(raw)), 8))
        }
        8 => Ok((SqliteCellValue::Integer(0), 0)),
        9 => Ok((SqliteCellValue::Integer(1), 0)),
        10 | 11 => Err("遇到保留的 SQLite serial type".to_string()),
        n if n >= 12 && n % 2 == 0 => {
            let len = usize::try_from((n - 12) / 2).map_err(|_| "Invalid SQLite blob size")?;
            if data.len() < len {
                return Err("BLOB 数据越界".to_string());
            }
            Ok((SqliteCellValue::Blob(data[0..len].to_vec()), len))
        }
        n if n >= 13 && n % 2 == 1 => {
            let len = usize::try_from((n - 13) / 2).map_err(|_| "Invalid SQLite text size")?;
            if data.len() < len {
                return Err("TEXT 数据越界".to_string());
            }
            let text = String::from_utf8_lossy(&data[0..len]).to_string();
            Ok((SqliteCellValue::Text(text), len))
        }
        _ => Err("未知 SQLite serial type".to_string()),
    }
}

fn read_signed(data: &[u8], len: usize) -> Result<i64, String> {
    if data.len() < len {
        return Err("整数数据越界".to_string());
    }
    let mut value = 0i64;
    for byte in &data[0..len] {
        value = (value << 8) | i64::from(*byte);
    }
    let shift = (8usize.saturating_sub(len)) * 8;
    Ok((value << shift) >> shift)
}

fn read_varint(data: &[u8], offset: usize) -> Result<(u64, usize), String> {
    if offset >= data.len() {
        return Err("读取 varint 越界".to_string());
    }

    let mut value = 0u64;
    for index in 0..9usize {
        let pos = offset + index;
        if pos >= data.len() {
            return Err("读取 varint 越界".to_string());
        }
        let byte = data[pos];

        if index == 8 {
            value = (value << 8) | u64::from(byte);
            return Ok((value, 9));
        }

        value = (value << 7) | u64::from(byte & 0x7F);
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
    }

    Err("varint 读取失败".to_string())
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, String> {
    if offset + 2 > data.len() {
        return Err("读取 u16 越界".to_string());
    }
    Ok(u16::from_be_bytes([data[offset], data[offset + 1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, String> {
    if offset + 4 > data.len() {
        return Err("读取 u32 越界".to_string());
    }
    Ok(u32::from_be_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn android_matches_nested_names_and_deduplicates() {
        let input = r#"log {"deviceName":"Test Band","nested":{"encryptKey":"0123456789ABCDEF0123456789ABCDEF"}} {"name":"Test Band","encrypt_key":"0123456789abcdef0123456789abcdef"} {"name":"Invalid","encryptKey":"short"}"#;
        let values = parse_android_log_text(input);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].name, "Test Band");
        assert_eq!(values[0].encrypt_key, "0123456789abcdef0123456789abcdef");
    }
    #[test]
    fn reads_ios_sqlite_archive() {
        let values = parse_ios_sqlite(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mifitness.sqlite"
        )))
        .unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].name, "Test Band");
        assert_eq!(values[0].encrypt_key, "0123456789abcdef0123456789abcdef");
    }
    #[test]
    fn rejects_cyclic_sqlite_tree() {
        let mut bytes = vec![0u8; 512];
        bytes[..16].copy_from_slice(b"SQLite format 3\0");
        bytes[16..18].copy_from_slice(&512u16.to_be_bytes());
        bytes[100] = 5;
        bytes[108..112].copy_from_slice(&1u32.to_be_bytes());
        let sqlite = SqliteFile::parse(bytes).unwrap();
        assert!(sqlite.read_table_rows(1).unwrap_err().contains("cyclic"));
    }
    #[test]
    fn zip_reads_only_matching_logs() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("{}.zip", uuid::Uuid::new_v4()));
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file(
            "logs/XiaomiFit.main.log",
            zip::write::FileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"{"name":"Test","encryptKey":"0123456789abcdef0123456789abcdef"}"#)
            .unwrap();
        zip.start_file("unrelated.json", zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(br#"{"name":"Ignored","encryptKey":"0123456789abcdef0123456789abcdef"}"#)
            .unwrap();
        zip.finish().unwrap();
        let values = extract(&path, "android").unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].name, "Test");
    }
}
