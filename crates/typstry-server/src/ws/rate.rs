//! Token bucket for per-connection update rate limiting.

use std::time::Instant;

#[derive(Debug, Clone)]
pub struct TokenBucket {
    capacity: f64,
    per_sec: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    /// Starts full, so a client that just joined can flush its backlog.
    pub fn new(capacity: u32, per_sec: f64, now: Instant) -> Self {
        Self {
            capacity: f64::from(capacity),
            per_sec,
            tokens: f64::from(capacity),
            last: now,
        }
    }

    pub fn try_take(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn allows_burst_then_refills_at_rate() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(3, 2.0, start);
        assert!((0..3).all(|_| bucket.try_take(start)));
        assert!(!bucket.try_take(start));

        // 2 per second: one token after half a second, not before.
        assert!(!bucket.try_take(start + Duration::from_millis(400)));
        assert!(bucket.try_take(start + Duration::from_millis(500)));
        assert!(!bucket.try_take(start + Duration::from_millis(500)));

        // A long pause refills to capacity and no further.
        let later = start + Duration::from_secs(60);
        assert!((0..3).all(|_| bucket.try_take(later)));
        assert!(!bucket.try_take(later));
    }
}
