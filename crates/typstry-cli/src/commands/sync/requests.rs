//! Answering other typstry commands that ask the running sync.

use std::collections::BTreeSet;
use std::fmt::Write as _;

use anyhow::bail;

use crate::commands::{
    Output, guard_switch, info, print_warnings, push, status, switch_refusal, version,
};
use crate::engine::{Flush, Mode, Report, Scope};
use crate::mailbox::{Request, Response};

use super::{FLUSH_TIMEOUT, Live};

impl Live {
    /// Answers what other typstry commands in the folder asked for; see
    /// [`crate::mailbox`]. Runs between steps, so requests see the same
    /// state as the loop.
    pub(super) async fn answer_requests(&mut self) {
        // Whatever the loop ran into so far is its own news, not part of
        // the answer to whoever asks next.
        print_warnings(&mut Output::terminal(), &mut self.session);
        let waiting = match self.mailbox.take() {
            Ok(waiting) => waiting,
            Err(err) => {
                let line = format!("{err:#}");
                if self.warned.insert(line.clone()) {
                    eprintln!("sync: cannot read requests from other commands: {line}");
                }
                return;
            }
        };
        for (id, request) in waiting {
            let mut out = Output::collect();
            let result = match request {
                Ok(request) => self.handle(request, &mut out).await,
                Err(err) => Err(err),
            };
            print_warnings(&mut out, &mut self.session);
            let response = Response {
                lines: out.into_lines(),
                error: result.err().map(|err| format!("{err:#}")),
            };
            self.mailbox.answer(&id, &response);
        }
    }

    pub(super) async fn handle(
        &mut self,
        request: Request,
        out: &mut Output,
    ) -> anyhow::Result<()> {
        match request {
            Request::Status => {
                if let Some(line) = self.state_line() {
                    out.out(format!("sync: {line}"));
                }
                status::print_status(&mut self.session, out).await
            }
            // The live doc is as fresh as a fetch would make it; "offline"
            // means the same as for the standalone command.
            Request::Info => {
                let sync = self.describe();
                let offline = !self.session.is_connected();
                info::print_info(&mut self.session, offline, &sync, out).await
            }
            Request::VersionList => {
                version::print_versions(self.session.doc(), out);
                Ok(())
            }
            Request::VersionSave { name, force } => self.save_version(&name, force, out).await,
            Request::Push { force } => self.push_now(force, out).await,
            Request::Pull => {
                self.describe_pull(out);
                Ok(())
            }
        }
    }

    /// Why sync is not syncing the folder right now, if it is not.
    pub(super) fn pause_reason(&self) -> Option<String> {
        let pause = self.pause.as_ref()?;
        Some(
            pause
                .git
                .reason()
                .unwrap_or_else(|| "waiting for git to settle".to_owned()),
        )
    }

    /// Anything unusual about sync, for `typstry status`.
    pub(super) fn state_line(&self) -> Option<String> {
        if let Some(reason) = self.pause_reason() {
            return Some(format!("paused, {reason}"));
        }
        if self.holding() {
            return Some(
                "holding back outgoing changes after a branch switch; publish them with typstry push --force"
                    .to_owned(),
            );
        }
        (!self.session.is_connected()).then(|| "offline, retrying in the background".to_owned())
    }

    /// The `Sync:` line of `typstry info`.
    pub(super) fn describe(&self) -> String {
        let mut line = format!("running (pid {})", std::process::id());
        if let Some(reason) = self.pause_reason() {
            let _ = write!(line, ", paused: {reason}");
        } else if self.holding() {
            line.push_str(", holding back outgoing changes after a branch switch");
        }
        if !self.session.is_connected() {
            line.push_str(", offline");
        }
        line
    }

    pub(super) fn describe_pull(&self, out: &mut Output) {
        out.out("typstry sync is running and already pulls remote changes.");
        if let Some(reason) = self.pause_reason() {
            out.out(format!(
                "It is paused right now ({reason}); remote changes arrive once it resumes."
            ));
        } else if !self.session.is_connected() {
            out.out("It is offline right now and pulls once it is connected again.");
        }
        if self.holding() {
            out.out("Outgoing changes are held back after a branch switch; see typstry status.");
        }
        let pinned: Vec<&str> = self.session.pinned_paths().collect();
        if !pinned.is_empty() {
            out.out(format!(
                "Remote changes wait because these files changed here too: {}",
                pinned.join(", ")
            ));
        }
    }

    pub(super) fn refuse_while_paused(&self, what: &str) -> anyhow::Result<()> {
        if let Some(reason) = self.pause_reason() {
            bail!(
                "typstry sync is paused ({reason}); {what} once the tracked branch is checked out and git is done"
            );
        }
        Ok(())
    }

    /// Ends a hold for a command that publishes. Like the one-shot
    /// commands, that takes --force while the folder still differs from
    /// the last sync. Returns what the flush after it has to scan: nothing
    /// once the check found that the folder matches the last sync.
    pub(super) async fn release_for(
        &mut self,
        force: bool,
        out: &mut Output,
    ) -> anyhow::Result<Scope> {
        if !self.holding() {
            return Ok(Scope::Full);
        }
        let scope = if force {
            Scope::Full
        } else {
            let status = self.session.status(&Scope::Full).await?;
            if !status.local.is_empty() {
                return Err(switch_refusal(&status.local));
            }
            Scope::Paths(BTreeSet::new())
        };
        out.out("sync: publishing held changes");
        self.release();
        Ok(scope)
    }

    /// Publishes what is on disk now rather than when the watcher reports
    /// it, so a command right after a save already includes the save.
    pub(super) async fn flush(&mut self, scope: &Scope) -> anyhow::Result<Report> {
        let mut report = self
            .session
            .reconcile(scope, Mode::Push, Flush::Deferred)
            .await?;
        // The scan covered whatever the watcher had queued, be it this one
        // or the one in release_for.
        self.local.clear();
        self.after(&mut report).await;
        Ok(report)
    }

    pub(super) async fn push_now(&mut self, force: bool, out: &mut Output) -> anyhow::Result<()> {
        self.refuse_while_paused("push")?;
        guard_switch(&mut self.session, force).await?;
        let scope = self.release_for(force, out).await?;
        let report = self.flush(&scope).await?;
        push::print_pushed(out, &report);
        if !self.session.is_connected() {
            out.out("typstry sync is offline; the changes go out once it is connected again.");
        }
        Ok(())
    }

    pub(super) async fn save_version(
        &mut self,
        name: &str,
        force: bool,
        out: &mut Output,
    ) -> anyhow::Result<()> {
        if !self.session.can_write() {
            bail!("{}", version::VIEW_ONLY_SAVE);
        }
        self.refuse_while_paused("save the version")?;
        if !self.session.is_connected() {
            bail!("typstry sync is offline; save the version once it is connected again");
        }
        guard_switch(&mut self.session, force).await?;
        let scope = self.release_for(force, out).await?;
        let report = self.flush(&scope).await?;
        version::print_pre_save_push(out, &report);
        let saved = version::name_current_state(&mut self.session, name)?;
        self.dirty = true;
        let sent = if self.session.is_connected() {
            tokio::time::timeout(FLUSH_TIMEOUT, self.session.push_local())
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("the server did not confirm it in time")))
        } else {
            Err(anyhow::anyhow!("lost the connection"))
        };
        if let Err(err) = sent {
            bail!(
                "saved version #{} {:?}, but it has not reached the server yet ({err:#}); sync sends it once it is connected again",
                saved.index,
                saved.name
            );
        }
        version::print_saved(out, &saved);
        Ok(())
    }

    /// Turns away requests that came in too late to be answered.
    pub(super) fn refuse_requests(&self, error: &str) {
        for (id, _) in self.mailbox.take().unwrap_or_default() {
            let response = Response {
                lines: Vec::new(),
                error: Some(error.to_owned()),
            };
            self.mailbox.answer(&id, &response);
        }
    }
}
