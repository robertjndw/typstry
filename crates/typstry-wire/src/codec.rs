//! Pieces of the binary layouts shared by the delivery service messages and
//! the saved MLS state.

use loro_protocol::{BytesReader, BytesWriter};

/// Why a shared helper could not read. Each caller maps it to its own
/// error type and wording.
pub(crate) enum CodecError {
    Read(String),
    /// A flag byte other than 0 or 1.
    Flag(u8),
}

impl From<String> for CodecError {
    fn from(why: String) -> Self {
        Self::Read(why)
    }
}

impl From<CodecError> for String {
    fn from(err: CodecError) -> Self {
        match err {
            CodecError::Read(why) => why,
            CodecError::Flag(v) => format!("flag {v}"),
        }
    }
}

/// Reads the leading uleb128 count and checks it against the bytes left.
/// Readers pre-allocate from that count, so a hostile one like 2^60 would
/// abort the process before any bounds check runs.
pub(crate) fn plausible_count(
    reader: &mut BytesReader<'_>,
    min_entry_bytes: usize,
) -> Result<u64, String> {
    let count = reader.read_uleb128()?;
    let room = (reader.remaining() / min_entry_bytes) as u64;
    if count > room {
        return Err(format!("count {count} exceeds the remaining bytes"));
    }
    Ok(count)
}

pub(crate) fn read_array<const N: usize>(reader: &mut BytesReader<'_>) -> Result<[u8; N], String> {
    Ok(reader
        .read_bytes(N)?
        .try_into()
        .expect("read exactly N bytes"))
}

pub(crate) fn push_opt(writer: &mut BytesWriter, value: Option<&[u8]>) {
    match value {
        Some(bytes) => {
            writer.push_byte(1);
            writer.push_var_bytes(bytes);
        }
        None => writer.push_byte(0),
    }
}

/// Reads a flag that must be exactly 0 or 1, so a value has one encoding.
pub(crate) fn read_flag(reader: &mut BytesReader<'_>) -> Result<bool, CodecError> {
    match reader.read_byte()? {
        0 => Ok(false),
        1 => Ok(true),
        other => Err(CodecError::Flag(other)),
    }
}

pub(crate) fn read_opt(reader: &mut BytesReader<'_>) -> Result<Option<Vec<u8>>, CodecError> {
    Ok(if read_flag(reader)? {
        Some(reader.read_var_bytes()?.to_vec())
    } else {
        None
    })
}
