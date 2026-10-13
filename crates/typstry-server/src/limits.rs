//! The ceiling on open WebSockets across all clients. It is a safety net
//! for the server's own memory, not fairness between clients: holding one
//! address to its share is the reverse proxy's job, as only the proxy knows
//! who is really on the other end (see `compose.prod.yaml`).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const DEFAULT_MAX_CONNECTIONS: usize = 10_000;

/// Open WebSockets, counted against `max`.
#[derive(Debug, Clone)]
pub struct ConnCeiling {
    max: usize,
    open: Arc<AtomicUsize>,
}

/// The server already holds as many sockets as it is configured for.
#[derive(Debug, PartialEq, Eq)]
pub struct Full;

/// Holds one connection slot until dropped.
#[derive(Debug)]
pub struct ConnPermit {
    open: Arc<AtomicUsize>,
}

impl Drop for ConnPermit {
    fn drop(&mut self) {
        self.open.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ConnCeiling {
    pub fn new(max: usize) -> Self {
        Self {
            max,
            open: Arc::default(),
        }
    }

    /// A slot for one more WebSocket, if there is room.
    pub fn connect(&self) -> Result<ConnPermit, Full> {
        self.open
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < self.max).then_some(n + 1)
            })
            .map_err(|_| Full)?;
        Ok(ConnPermit {
            open: self.open.clone(),
        })
    }

    #[cfg(test)]
    fn open_connections(&self) -> usize {
        self.open.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_connections_in_total() {
        let ceiling = ConnCeiling::new(2);
        let first = ceiling.connect().unwrap();
        let _second = ceiling.connect().unwrap();
        assert_eq!(ceiling.connect().unwrap_err(), Full);

        drop(first);
        assert_eq!(ceiling.open_connections(), 1);
        assert!(ceiling.connect().is_ok());
    }
}
