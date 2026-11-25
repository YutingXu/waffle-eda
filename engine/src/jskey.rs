//! JavaScript string ordering for tie-breaks, so results match the JS fallback exactly.
//!
//! Strings arrive as UTF-16 code units (what `charCodeAt` returns). JS compares strings by
//! code unit, which is `<[u16]>::cmp`. `JSON.stringify` (ES2019, well-formed) escapes `"` and
//! `\`, the short control escapes, other controls below U+0020 and lone surrogates as
//! `\uxxxx` (lower-case hex); every other code unit is copied.

use core::cmp::Ordering;

/// Code units of `JSON.stringify(s)` without the surrounding quotes, one at a time.
pub struct Escaped<'a> {
    s: &'a [u16],
    i: usize,
    pending: [u16; 6],
    len: u8,
    at: u8,
}

impl<'a> Escaped<'a> {
    pub fn new(s: &'a [u16]) -> Self {
        Self { s, i: 0, pending: [0; 6], len: 0, at: 0 }
    }
}

fn hex(n: u16) -> u16 {
    let n = n & 15;
    if n < 10 { b'0' as u16 + n } else { b'a' as u16 + n - 10 }
}

impl Iterator for Escaped<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        if self.at < self.len {
            let unit = self.pending[self.at as usize];
            self.at += 1;
            return Some(unit);
        }
        let unit = *self.s.get(self.i)?;
        self.i += 1;
        let short = match unit {
            0x08 => Some(b'b'),
            0x09 => Some(b't'),
            0x0a => Some(b'n'),
            0x0c => Some(b'f'),
            0x0d => Some(b'r'),
            0x22 => Some(b'"'),
            0x5c => Some(b'\\'),
            _ => None,
        };
        if let Some(c) = short {
            self.pending[0] = c as u16;
            self.len = 1;
            self.at = 0;
            return Some(b'\\' as u16);
        }
        let lone = match unit {
            0xd800..=0xdbff => !matches!(self.s.get(self.i), Some(0xdc00..=0xdfff)),
            0xdc00..=0xdfff => !matches!(self.i.checked_sub(2).and_then(|j| self.s.get(j)), Some(0xd800..=0xdbff)),
            _ => false,
        };
        if unit < 0x20 || lone {
            self.pending = [b'u' as u16, hex(unit >> 12), hex(unit >> 8), hex(unit >> 4), hex(unit), 0];
            self.len = 5;
            self.at = 0;
            return Some(b'\\' as u16);
        }
        Some(unit)
    }
}

/// `a < b` as JS compares two strings.
pub fn compare(a: &[u16], b: &[u16]) -> Ordering {
    a.cmp(b)
}

/// Orders `JSON.stringify([a0, a1])` against `JSON.stringify([b0, b1])` by code unit,
/// without building either string.
pub fn compare_pair_json(a0: &[u16], a1: &[u16], b0: &[u16], b1: &[u16]) -> Ordering {
    const MID: [u16; 3] = [b'"' as u16, b',' as u16, b'"' as u16];
    const END: [u16; 2] = [b'"' as u16, b']' as u16];
    let a = Escaped::new(a0).chain(MID).chain(Escaped::new(a1)).chain(END);
    let b = Escaped::new(b0).chain(MID).chain(Escaped::new(b1)).chain(END);
    a.cmp(b) // the common `["` prefix never decides
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> { s.encode_utf16().collect() }
    fn esc(units: &[u16]) -> String { String::from_utf16(&Escaped::new(units).collect::<Vec<_>>()).unwrap() }

    #[test]
    fn escapes_like_json_stringify() {
        assert_eq!(esc(&u("[\"o1\",0]/0")), "[\\\"o1\\\",0]/0");
        assert_eq!(esc(&u("a\\b\n\t\r\x08\x0c\x01\x1f")), "a\\\\b\\n\\t\\r\\b\\f\\u0001\\u001f");
        assert_eq!(esc(&[0xd83d, 0xde00]), "\u{1f600}");
        assert_eq!(esc(&[0xd83d, 0x41]), "\\ud83dA");
        assert_eq!(esc(&[0xde00, 0xd83d]), "\\ude00\\ud83d");
        assert_eq!(esc(&u("é\x7f")), "é\x7f");
    }

    #[test]
    fn pair_order_is_json_text_order() {
        // A prefix ends with `"` (0x22) in JSON, which sorts before `#` but after `!`.
        let (a, b, c) = (u("a"), u("a!"), u("a#"));
        assert_eq!(compare(&a, &b), Ordering::Less);
        assert_eq!(compare_pair_json(&a, &a, &b, &a), Ordering::Greater);
        assert_eq!(compare_pair_json(&a, &a, &c, &a), Ordering::Less);
        // A quote escapes to `\"` (0x5c), which sorts after letters.
        assert_eq!(compare_pair_json(&u("\"x"), &a, &u("Ax"), &a), Ordering::Greater);
        assert_eq!(compare_pair_json(&a, &u("p"), &a, &u("q")), Ordering::Less);
        assert_eq!(compare_pair_json(&a, &u("p"), &a, &u("p")), Ordering::Equal);
    }
}
