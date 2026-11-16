/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Targeted pin edits: preserve all bytes outside the pin value, including CRLF and BOM.
use serde_json::{Value, Error};
use std::ops::Range;

fn invalid(message: &str) -> Error { <Error as serde::de::Error>::custom(message) }
fn whitespace(text: &str, mut offset: usize) -> usize {
    while text.as_bytes().get(offset).map_or(false, u8::is_ascii_whitespace) { offset += 1; }
    offset
}
fn end(text: &str, start: usize) -> Result<usize, Error> {
    let mut stream = serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>();
    stream.next().ok_or_else(|| invalid("Missing JSON value"))??;
    Ok(start + stream.byte_offset())
}
fn property(text: &str, object: usize, key: &str) -> Result<Option<Range<usize>>, Error> {
    if text.as_bytes().get(object) != Some(&b'{') { return Err(invalid("Metadata must contain objects")); }
    let mut offset = whitespace(text, object + 1);
    let mut found = None;
    while text.as_bytes().get(offset) != Some(&b'}') {
        let key_end = end(text, offset)?;
        let name: String = serde_json::from_str(&text[offset..key_end])?;
        let colon = whitespace(text, key_end);
        let start = whitespace(text, colon + 1);
        let value_end = end(text, start)?;
        if name == key {
            if found.is_some() { return Err(invalid("Duplicate metadata key")); }
            found = Some(start..value_end);
        }
        offset = whitespace(text, value_end);
        if text.as_bytes().get(offset) == Some(&b',') { offset = whitespace(text, offset + 1); }
    }
    Ok(found)
}
fn indent(text: &str, offset: usize) -> &str {
    let start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
    let line = &text[start..offset];
    &line[..line.bytes().take_while(|b| *b == b' ' || *b == b'\t').count()]
}
fn unit(text: &str) -> &str {
    text.lines().filter_map(|line| {
        let trimmed = line.trim_start_matches([' ', '\t']);
        let length = line.len() - trimmed.len();
        if length > 0 && trimmed.starts_with('"') { Some(&line[..length]) } else { None }
    }).min_by_key(|s| s.len()).unwrap_or("    ")
}
fn format(text: &str, value: &Value, base: &str) -> Result<String, Error> {
    if !text.contains('\n') { return serde_json::to_string(value); }
    let mut bytes = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(unit(text).as_bytes());
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    serde::Serialize::serialize(value, &mut serializer)?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    Ok(String::from_utf8(bytes).unwrap().replace('\n', &format!("{}{}", newline, base)))
}
fn insert(text: &str, object: usize, key: &str, value: &Value) -> Result<String, Error> {
    let close = end(text, object)? - 1;
    let offset = text[object + 1..close].trim_end().len() + object + 1;
    let nonempty = !text[object + 1..close].trim().is_empty();
    let base = format!("{}{}", indent(text, object), unit(text));
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let pretty = text.contains('\n');
    let value = format(text, value, &base)?;
    let closing = if pretty && !text[offset..close].contains('\n') { format!("{}{}", newline, indent(text, object)) } else { String::new() };
    Ok(format!("{}{}{}{}{}:{}{}{}{}", &text[..offset], if nonempty { "," } else { "" }, if pretty { newline } else { "" }, if pretty { &base } else { "" }, serde_json::to_string(key)?, if pretty { " " } else { "" }, value, closing, &text[offset..]))
}
pub fn replace_pins(text: &str, pins: &Value) -> Result<String, Error> {
    let plain = text.strip_prefix('\u{feff}').unwrap_or(text);
    let _: Value = serde_json::from_str(plain)?;
    let root = whitespace(text, text.len() - plain.len());
    let meta = match property(text, root, "meta")? {
        Some(span) => span,
        None => return insert(text, root, "meta", &serde_json::json!({"pinnedExtensions": pins})),
    };
    match property(text, meta.start, "pinnedExtensions")? {
        Some(span) => {
            let value = format(text, pins, indent(text, span.start))?;
            Ok(format!("{}{}{}", &text[..span.start], value, &text[span.end..]))
        },
        None => insert(text, meta.start, "pinnedExtensions", pins),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_bytes_and_formats_timestamp_only_removal() {
        let text = "\u{feff}{\r\n  \"meta\": {\r\n    \"pinnedExtensions\": {},\r\n    \"other\": 1e2\r\n  }\r\n}\r\n";
        let result = replace_pins(text, &serde_json::json!({"editor":{"timestamp":123}})).unwrap();
        assert_eq!(result, text.replace("\"pinnedExtensions\": {}", "\"pinnedExtensions\": {\r\n      \"editor\": {\r\n        \"timestamp\": 123\r\n      }\r\n    }"));
        assert_eq!(replace_pins(&result, &serde_json::json!({})).unwrap(), text);
    }
    #[test]
    fn inserts_without_reformatting_other_fields() {
        for text in ["{}", "{\"meta\":{}}", "{\n\t\"meta\": {}\n}"] {
            let result = replace_pins(text, &serde_json::json!({"editor":{"timestamp":123}})).unwrap();
            let parsed: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(parsed["meta"]["pinnedExtensions"]["editor"]["timestamp"], 123);
        }
    }
    #[test]
    fn rejects_duplicate_and_invalid_metadata() {
        for text in ["{\"meta\":{},\"meta\":{}}", "{\"meta\":{\"pinnedExtensions\":{},\"pinnedExtensions\":{}}}", "{\"meta\":null}", "[]"] {
            assert!(replace_pins(text, &serde_json::json!({})).is_err());
        }
    }
}
