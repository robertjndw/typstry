//! Random identifiers for projects and share links. The server mints them
//! for new projects, and clients mint the ones a rotation switches to, so
//! the server never learns which secret a token belongs to. Both sides have
//! to agree on the shape the server checks.

const ALPHABET: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// 62^22 > 2^128, so every 128-bit value fits in 22 digits.
pub const TOKEN_LEN: usize = 22;

/// 128 random bits as a fixed-width base62 string. Fixed width keeps tokens
/// easy to validate and avoids leaking the magnitude of the random value.
pub fn generate() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random source unavailable");
    encode(u128::from_le_bytes(bytes))
}

fn encode(mut value: u128) -> String {
    let mut out = [b'0'; TOKEN_LEN];
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(value % 62) as usize];
        value /= 62;
    }
    String::from_utf8(out.to_vec()).expect("alphabet is ASCII")
}

/// Cheap shape check before touching the database.
pub fn looks_valid(token: &str) -> bool {
    token.len() == TOKEN_LEN && token.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_extremes_at_fixed_width() {
        assert_eq!(encode(0), "0".repeat(TOKEN_LEN));
        assert_eq!(encode(u128::MAX), "7n42DGM5Tflk9n8mt7Fhc7");
        assert!(looks_valid(&encode(u128::MAX)));
    }

    #[test]
    fn generates_distinct_valid_tokens() {
        let a = generate();
        let b = generate();
        assert_ne!(a, b);
        assert!(looks_valid(&a) && looks_valid(&b));
        assert!(!looks_valid("short"));
        assert!(!looks_valid(&format!("{}-", &a[..TOKEN_LEN - 1])));
    }
}
