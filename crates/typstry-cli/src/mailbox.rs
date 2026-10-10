//! How commands reach a running `typstry sync`. Sync holds the folder's
//! lock, so instead of failing, a command drops a request into
//! `.typstry/requests/` and waits for the answer next to it. Sync looks
//! for requests between its own steps, so one never races the engine.
//!
//! Plain files rather than a socket: a Unix socket path is limited to
//! about a hundred bytes, which deep project folders exceed, and files
//! work the same on every platform. The folder is as private as the rest
//! of the state, and every file in it is written atomically.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

use crate::commands::Line;
use crate::state::{SyncRunning, create_private_dir, random_hex, write_json};

pub const MAILBOX: &str = "requests";
const REQUEST: &str = ".req";
const RESPONSE: &str = ".res";

/// Sync looks at the mailbox when its file watcher sees a request, and
/// every few seconds in case it missed one, unless it is in the middle of
/// a long reconcile or upload.
const PICKUP_TIMEOUT: Duration = Duration::from_secs(15);

/// Covers a reconcile plus waiting for the server's acks, which time out
/// on their own well before this.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(150);

const POLL: Duration = Duration::from_millis(50);

/// Sent with every request, since a running sync survives an upgrade and
/// may be an older build than the command. Bump it when an existing request
/// or [`Response`] changes. A new request needs no bump, an older sync
/// already answers unknown ones with an error.
pub const PROTOCOL: u32 = 1;
const PROTOCOL_KEY: &str = "protocol";

const OTHER_VERSION: &str = "the running `typstry sync` is a different typstry version than this command; stop it with Ctrl+C and start it again";

/// What a command asks the running sync to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase")]
pub enum Request {
    Status,
    Info,
    VersionList,
    VersionSave { name: String, force: bool },
    Push { force: bool },
    Pull,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Response {
    /// What the command would have printed, in order.
    pub lines: Vec<Line>,
    /// Set when the command failed; the asking process exits with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Has the sync behind `running` handle `request`, prints its output and
/// fails if the request failed.
pub async fn ask(running: &SyncRunning, request: &Request) -> anyhow::Result<()> {
    let dir = running.dir.join(MAILBOX);
    if !dir.is_dir() {
        // A sync that is still starting, or one from before requests
        // existed.
        bail!("{running}");
    }
    let id = random_hex(8);
    let request_path = dir.join(format!("{id}{REQUEST}"));
    let response_path = dir.join(format!("{id}{RESPONSE}"));
    write_json(&request_path, &Envelope::new(request))?;

    let started = Instant::now();
    let mut taken = false;
    loop {
        tokio::time::sleep(POLL).await;
        match fs::read(&response_path) {
            Ok(bytes) => {
                let _ = fs::remove_file(&response_path);
                let response: Response = serde_json::from_slice(&bytes).map_err(|err| {
                    anyhow::anyhow!("{OTHER_VERSION} (cannot read its answer: {err})")
                })?;
                for line in &response.lines {
                    line.print();
                }
                return match response.error {
                    Some(error) => Err(anyhow::Error::msg(error)),
                    None => Ok(()),
                };
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err).with_context(|| format!("reading {}", response_path.display()));
            }
        }
        if !taken && !request_path.exists() {
            taken = true;
        }
        if !taken && started.elapsed() > PICKUP_TIMEOUT {
            // Whoever removes the request first owns it: if this succeeds,
            // sync never saw it and nothing happened.
            match fs::remove_file(&request_path) {
                Ok(()) => bail!(
                    "`typstry sync` ({}) did not take the request; check its terminal, or stop it with Ctrl+C and run the command again",
                    running.holder
                ),
                Err(err) if err.kind() == io::ErrorKind::NotFound => taken = true,
                Err(err) => {
                    return Err(err)
                        .with_context(|| format!("removing {}", request_path.display()));
                }
            }
        }
        if started.elapsed() > ANSWER_TIMEOUT {
            bail!(
                "`typstry sync` ({}) did not answer in time; check its terminal for what happened",
                running.holder
            );
        }
    }
}

/// A request as it goes into the mailbox, with the protocol next to the
/// command. The field name must match [`PROTOCOL_KEY`].
#[derive(Serialize)]
struct Envelope<'a> {
    protocol: u32,
    #[serde(flatten)]
    request: &'a Request,
}

impl<'a> Envelope<'a> {
    fn new(request: &'a Request) -> Self {
        Self {
            protocol: PROTOCOL,
            request,
        }
    }
}

/// Checks the protocol before parsing the command, so a mismatch gets the
/// restart hint and not some random parse error.
fn parse_request(bytes: &[u8]) -> anyhow::Result<Request> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|err| anyhow::anyhow!("typstry sync cannot read the request: {err}"))?;
    let protocol = value.get(PROTOCOL_KEY).and_then(serde_json::Value::as_u64);
    if protocol != Some(u64::from(PROTOCOL)) {
        bail!("{OTHER_VERSION}");
    }
    serde_json::from_value(value).map_err(|err| anyhow::anyhow!("{OTHER_VERSION} ({err})"))
}

/// Sync's end of the mailbox.
#[derive(Debug)]
pub struct Mailbox {
    dir: PathBuf,
}

impl Mailbox {
    /// Creates the mailbox in the state folder `state`, emptied of
    /// whatever a sync that crashed left behind.
    pub fn open(state: &Path) -> anyhow::Result<Self> {
        let dir = state.join(MAILBOX);
        if !dir.is_dir() {
            create_private_dir(&dir)?;
        }
        let mailbox = Self { dir };
        for path in mailbox.entries()? {
            let _ = fs::remove_file(path);
        }
        Ok(mailbox)
    }

    fn entries(&self) -> anyhow::Result<Vec<PathBuf>> {
        let entries =
            fs::read_dir(&self.dir).with_context(|| format!("reading {}", self.dir.display()))?;
        Ok(entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect())
    }

    /// The requests waiting, oldest first, each removed from the mailbox.
    /// One that does not parse comes back as an error to answer with.
    pub fn take(&self) -> anyhow::Result<Vec<(String, anyhow::Result<Request>)>> {
        let mut waiting = Vec::new();
        for path in self.entries()? {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Dot files are atomic writes still in progress.
            let Some(id) = name
                .strip_suffix(REQUEST)
                .filter(|_| !name.starts_with('.'))
            else {
                continue;
            };
            let modified = fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            // The asker removes a request it gave up on; only one of us
            // gets to remove it.
            if fs::remove_file(&path).is_err() {
                continue;
            }
            let request = parse_request(&bytes);
            waiting.push((modified, id.to_owned(), request));
        }
        waiting.sort_by_key(|(modified, id, _)| (*modified, id.clone()));
        Ok(waiting
            .into_iter()
            .map(|(_, id, request)| (id, request))
            .collect())
    }

    pub fn answer(&self, id: &str, response: &Response) {
        let path = self.dir.join(format!("{id}{RESPONSE}"));
        if let Err(err) = write_json(&path, response) {
            eprintln!("sync: cannot answer a request: {err:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mailbox_with(request: &str) -> (tempfile::TempDir, Mailbox) {
        let dir = tempfile::tempdir().unwrap();
        let mailbox = Mailbox::open(dir.path()).unwrap();
        fs::write(mailbox.dir.join(format!("abc{REQUEST}")), request).unwrap();
        (dir, mailbox)
    }

    fn take_one(mailbox: &Mailbox) -> anyhow::Result<Request> {
        let mut waiting = mailbox.take().unwrap();
        assert_eq!(waiting.len(), 1);
        let (id, request) = waiting.remove(0);
        assert_eq!(id, "abc");
        request
    }

    #[test]
    fn requests_round_trip_with_the_protocol() {
        let request = Request::VersionSave {
            name: "v1".into(),
            force: true,
        };
        let json = serde_json::to_value(Envelope::new(&request)).unwrap();
        assert_eq!(json[PROTOCOL_KEY], PROTOCOL);
        let (_dir, mailbox) = mailbox_with(&json.to_string());
        assert_eq!(take_one(&mailbox).unwrap(), request);
    }

    #[test]
    fn another_protocol_gets_a_restart_hint() {
        // A command from before the protocol existed.
        let (_dir, mailbox) = mailbox_with(r#"{"command":"status"}"#);
        let err = take_one(&mailbox).unwrap_err();
        assert!(
            err.to_string().contains("different typstry version"),
            "{err}"
        );
        // What sync then answers, as the asking command reads it.
        mailbox.answer(
            "abc",
            &Response {
                lines: Vec::new(),
                error: Some(format!("{err:#}")),
            },
        );
        let answer = fs::read(mailbox.dir.join(format!("abc{RESPONSE}"))).unwrap();
        let answer: Response = serde_json::from_slice(&answer).unwrap();
        assert!(answer.error.unwrap().contains("start it again"));

        let newer = format!(r#"{{"command":"status","protocol":{}}}"#, PROTOCOL + 1);
        let (_dir, mailbox) = mailbox_with(&newer);
        let err = take_one(&mailbox).unwrap_err();
        assert!(
            err.to_string().contains("different typstry version"),
            "{err}"
        );
    }

    #[test]
    fn an_unknown_command_gets_a_restart_hint() {
        let request = format!(r#"{{"command":"fly","protocol":{PROTOCOL}}}"#);
        let (_dir, mailbox) = mailbox_with(&request);
        let err = take_one(&mailbox).unwrap_err();
        assert!(
            err.to_string().contains("different typstry version"),
            "{err}"
        );
    }
}
