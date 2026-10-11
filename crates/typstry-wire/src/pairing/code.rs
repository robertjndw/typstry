//! The pairing code a person reads off one device and types into the other:
//! `42-ivory-galaxy`. The number names the relay channel, the two words are
//! the shared secret.

use std::fmt;
use std::str::FromStr;

use crate::crypto::random;
use crate::relay::CHANNEL_MAX;
use crate::words::{WORDS, word_index};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodeError {
    #[error("channel {0} is not between 1 and {CHANNEL_MAX}")]
    Channel(u16),
    #[error("the code should look like 42-word-word")]
    Shape,
    #[error("\"{0}\" is not a word of the code")]
    Word(String),
}

/// A channel number and two words. Two words are 16 bits, which is enough
/// only because the protocol allows exactly one guess per code.
#[derive(Clone, PartialEq, Eq)]
pub struct Code {
    channel: u16,
    words: [u8; 2],
}

impl Code {
    /// A fresh code for `channel`, as the side that opened it shows.
    pub fn generate(channel: u16) -> Result<Self, CodeError> {
        Self::new(channel, random())
    }

    pub fn new(channel: u16, words: [u8; 2]) -> Result<Self, CodeError> {
        if channel == 0 || channel > CHANNEL_MAX {
            return Err(CodeError::Channel(channel));
        }
        Ok(Self { channel, words })
    }

    pub fn channel(&self) -> u16 {
        self.channel
    }

    /// Accepts a bare code or a link like `https://host/pair#42-ivory-galaxy`.
    /// Only the fragment of a link counts, which never reaches the server.
    pub fn from_link_or_code(input: &str) -> Result<Self, CodeError> {
        let input = input.trim();
        match input.split_once('#') {
            Some((_, fragment)) => fragment.parse(),
            None => input.parse(),
        }
    }

    /// The SPAKE2 password. It includes the channel number, so a code only
    /// works on the channel it was shown for.
    pub(super) fn password(&self) -> Vec<u8> {
        self.to_string().into_bytes()
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}-{}-{}",
            self.channel,
            WORDS[usize::from(self.words[0])],
            WORDS[usize::from(self.words[1])]
        )
    }
}

// The words are the secret, so they stay out of logs.
impl fmt::Debug for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Code")
            .field("channel", &self.channel)
            .finish_non_exhaustive()
    }
}

impl FromStr for Code {
    type Err = CodeError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let lower = s.trim().to_ascii_lowercase();
        let mut parts = lower.split('-');
        let (Some(channel), Some(a), Some(b), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(CodeError::Shape);
        };
        if channel.is_empty() || !channel.bytes().all(|b| b.is_ascii_digit()) {
            return Err(CodeError::Shape);
        }
        // Too many digits for a u16 is just as wrong as a channel past the max.
        let channel = channel.parse().map_err(|_| CodeError::Channel(u16::MAX))?;
        let word = |w: &str| word_index(w).ok_or_else(|| CodeError::Word(w.to_string()));
        Self::new(channel, [word(a)?, word(b)?])
    }
}
