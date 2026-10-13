//! A single self-updating "time left" line for the wait on another device.
//! It needs no raw mode: the line is rewritten in place and wiped again
//! before anything else prints.

use std::io::Write;
use std::time::{Duration, Instant};

/// Owns the line it draws. Dropping it wipes the line, so every exit path
/// (a frame arriving, an error, the outer timeout dropping the future)
/// leaves the cursor at the start of an empty line.
pub struct Countdown {
    started: Instant,
    total: Duration,
}

impl Countdown {
    pub fn new(total: Duration) -> Self {
        Self {
            started: Instant::now(),
            total,
        }
    }

    pub fn draw(&self) {
        let left = self.total.saturating_sub(self.started.elapsed());
        let mut out = std::io::stdout().lock();
        // No newline, so the next draw can overwrite this one.
        let _ = write!(
            out,
            "\r\x1b[2KWaiting for the other device... {} left",
            format_remaining(left)
        );
        let _ = out.flush();
    }
}

impl Drop for Countdown {
    fn drop(&mut self) {
        let mut out = std::io::stdout().lock();
        let _ = write!(out, "\r\x1b[2K");
        let _ = out.flush();
    }
}

/// `m:ss`, rounded up so the line never shows 0:00 while time remains.
pub fn format_remaining(left: Duration) -> String {
    let secs = left.as_secs() + u64::from(left.subsec_nanos() > 0);
    format!("{}:{:02}", secs / 60, secs % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_minutes_and_seconds() {
        assert_eq!(format_remaining(Duration::from_secs(300)), "5:00");
        assert_eq!(format_remaining(Duration::from_secs(272)), "4:32");
        assert_eq!(format_remaining(Duration::from_secs(9)), "0:09");
        assert_eq!(format_remaining(Duration::ZERO), "0:00");
    }

    #[test]
    fn rounds_partial_seconds_up() {
        assert_eq!(format_remaining(Duration::from_millis(4_100)), "0:05");
        assert_eq!(format_remaining(Duration::from_millis(59_001)), "1:00");
    }
}
