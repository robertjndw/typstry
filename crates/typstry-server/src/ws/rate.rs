//! Token bucket for rate limiting, per connection.

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

    /// Charges `cost` tokens if at least one is left. A cost above what is
    /// left still goes through and puts the bucket in debt: a batch bigger
    /// than the burst would otherwise be refused forever.
    ///
    /// The debt is capped at one burst. One message can carry hundreds of
    /// thousands of tiny records, and paying all of them back would lock
    /// the connection out of live edits for half an hour. With the cap, a
    /// huge batch costs at most two bursts' worth of waiting.
    pub fn try_take(&mut self, now: Instant, cost: u32) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens = (self.tokens - f64::from(cost)).max(-self.capacity);
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
        assert!((0..3).all(|_| bucket.try_take(start, 1)));
        assert!(!bucket.try_take(start, 1));

        // 2 per second: one token after half a second, not before.
        assert!(!bucket.try_take(start + Duration::from_millis(400), 1));
        assert!(bucket.try_take(start + Duration::from_millis(500), 1));
        assert!(!bucket.try_take(start + Duration::from_millis(500), 1));

        // A long pause refills to capacity and no further.
        let later = start + Duration::from_secs(60);
        assert!((0..3).all(|_| bucket.try_take(later, 1)));
        assert!(!bucket.try_take(later, 1));
    }

    #[test]
    fn oversized_costs_go_through_once_and_are_paid_back() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(3, 2.0, start);
        assert!(bucket.try_take(start, 2));
        assert!(bucket.try_take(start, 4), "one token left is enough");
        // Three tokens in debt: back to one after two seconds.
        assert!(!bucket.try_take(start + Duration::from_millis(1900), 1));
        assert!(bucket.try_take(start + Duration::from_millis(2100), 1));
    }

    #[test]
    fn debt_is_capped_at_one_burst() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(3, 2.0, start);
        assert!(bucket.try_take(start, 1_000_000));
        // Capped at three in debt, so one token is back after two seconds
        // instead of days.
        assert!(!bucket.try_take(start + Duration::from_millis(1900), 1));
        assert!(bucket.try_take(start + Duration::from_millis(2100), 1));
    }
}
