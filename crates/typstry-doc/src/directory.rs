//! A person's directory of projects: which projects they know, the best
//! link to open each with, and when they last opened it.
//!
//! Names and rules must stay in sync with `apps/web/src/directory/`, which
//! reads and writes the same containers.
//!
//! Everything lives in flat root maps of plain values, never in a child
//! container per entry: two devices creating the same nested container at
//! once conflict and one of them wins whole. A plain value is replaced
//! whole, last writer wins per key, which is all an entry needs. Unknown root
//! maps and unknown keys inside values are ignored, and kept when this code
//! rewrites an entry, so a newer client can add fields.
//!
//! The doc is written by every device of one person, so reads treat it as
//! untrusted: an entry that does not validate is skipped, never an error.

use std::collections::{BTreeMap, HashMap};

use loro::{LoroDoc, LoroError, LoroMap, LoroResult, LoroValue};
use typstry_wire::crypto::LinkSecret;
use typstry_wire::owner::OwnerSecret;
use typstry_wire::token;

use crate::{kind, meta, normalize_title, root as doc_root, schema_version, string_value};

/// Bumped when an older client writing into the directory would corrupt it,
/// same rules as [`crate::SCHEMA_VERSION`]. Must match
/// `DIRECTORY_SCHEMA_VERSION` in `directory/schema.ts`.
pub const DIRECTORY_SCHEMA_VERSION: i64 = 1;

/// `touch_opened` skips a write unless the old one is at least this old, so
/// opening a project does not add an op every time.
pub const OPENED_REFRESH_MS: i64 = 60 * 60 * 1000;

/// How long a retired link is kept before [`prune_retired`] drops it.
pub const RETIRED_KEEP_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// Entries dated further than this past `now` are ignored on read. A device
/// that is later revoked could otherwise plant a far-future `addedAt` to win
/// every ranking for good; a day covers honest clock skew.
pub const FUTURE_SLACK_MS: i64 = 24 * 60 * 60 * 1000;

/// Root containers beyond `meta`.
pub mod root {
    /// Share token -> `{projectId, secret, edit, addedAt, generation?}`.
    pub const LINKS: &str = "links";
    /// Share token -> unix ms when it was seen retired.
    pub const RETIRED: &str = "retired";
    /// Project id -> title.
    pub const TITLES: &str = "titles";
    /// Project id -> unix ms of the last open.
    pub const OPENED: &str = "opened";
    /// Project id -> `{state, at, token?}`.
    pub const STATUS: &str = "status";
    /// `"<projectId>/<owner public key hex>"` -> `{secret, addedAt}`.
    pub const OWNER_KEYS: &str = "ownerKeys";
}

/// Keys of each value in `links`.
pub mod link {
    pub const PROJECT_ID: &str = "projectId";
    pub const SECRET: &str = "secret";
    pub const EDIT: &str = "edit";
    pub const ADDED_AT: &str = "addedAt";
    /// Stored and parsed for compatibility, never used for ranking: nobody
    /// writes a trusted one.
    pub const GENERATION: &str = "generation";
}

/// Keys of each value in `status`.
pub mod status {
    pub const STATE: &str = "state";
    pub const AT: &str = "at";
    pub const TOKEN: &str = "token";
}

/// Keys of each value in `ownerKeys`.
pub mod owner_key {
    /// The 32 byte owner secret, base64url without padding.
    pub const SECRET: &str = "secret";
    pub const ADDED_AT: &str = "addedAt";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Listed,
    /// The person dropped it from their list. Applies whatever link is best.
    Forgotten,
    /// Someone removed this person from the project, as seen through the
    /// link in `status.token`.
    Removed,
    /// The server no longer knows the project, as seen through that link.
    Gone,
}

impl State {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Listed => "listed",
            Self::Forgotten => "forgotten",
            Self::Removed => "removed",
            Self::Gone => "gone",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "listed" => Some(Self::Listed),
            "forgotten" => Some(Self::Forgotten),
            "removed" => Some(Self::Removed),
            "gone" => Some(Self::Gone),
            _ => None,
        }
    }
}

/// One of a project's links.
#[derive(Clone, PartialEq, Eq)]
pub struct LinkRef {
    pub token: String,
    pub secret: String,
    pub edit: bool,
    /// Seen retired. Only the best link of a project whose links are all
    /// retired comes back like this, so a caller can still try to catch up.
    pub retired: bool,
}

// Keeps the secret out of logs.
impl std::fmt::Debug for LinkRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkRef")
            .field("token", &self.token)
            .field("edit", &self.edit)
            .field("retired", &self.retired)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub project_id: String,
    pub title: Option<String>,
    pub link: LinkRef,
    pub state: State,
    pub opened_at: Option<i64>,
    /// When the project's first link was learned.
    pub added_at: i64,
}

/// A link to record with [`add_link`].
pub struct NewLink<'a> {
    pub token: &'a str,
    pub project_id: &'a str,
    pub secret: &'a str,
    pub edit: bool,
    pub added_at: i64,
    pub generation: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum DirectoryError {
    #[error("not a valid link: {0}")]
    InvalidLink(&'static str),
    #[error(transparent)]
    Loro(#[from] LoroError),
}

/// The doc is not a directory this build can write to.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Unsupported {
    #[error("this document is not a directory")]
    NotDirectory { found: String },
    #[error(
        "this directory uses document layout {found}, but this typstry only supports up to {supported}; upgrade typstry"
    )]
    TooNew { found: i64, supported: i64 },
}

/// Fails for a doc that is some other kind than a directory, or whose
/// schema is newer than [`DIRECTORY_SCHEMA_VERSION`]. A doc without a kind
/// or schema yet (still syncing) passes.
pub fn ensure_supported(doc: &LoroDoc) -> Result<(), Unsupported> {
    if let Some(found) = crate::doc_kind(doc)
        && found != kind::DIRECTORY
    {
        return Err(Unsupported::NotDirectory { found });
    }
    match schema_version(doc) {
        Some(found) if found > DIRECTORY_SCHEMA_VERSION => Err(Unsupported::TooNew {
            found,
            supported: DIRECTORY_SCHEMA_VERSION,
        }),
        _ => Ok(()),
    }
}

/// Marks an empty doc as a directory. Does nothing once the doc carries a
/// kind or schema. Deterministic, so two devices doing it at once write the
/// same values and merge into one.
pub fn init(doc: &LoroDoc) -> LoroResult<()> {
    let meta_map = doc.get_map(doc_root::META);
    if crate::doc_kind(doc).is_some() || schema_version(doc).is_some() {
        return Ok(());
    }
    configure(doc);
    meta_map.insert(meta::KIND, kind::DIRECTORY)?;
    // A double, like the browser writes.
    meta_map.insert(meta::SCHEMA, DIRECTORY_SCHEMA_VERSION as f64)?;
    doc.set_next_commit_message("init directory");
    doc.commit();
    Ok(())
}

/// The per-instance settings the browser's `Directory` applies: what
/// [`crate::configure`] is for a project. Not synced, so every directory doc
/// that will be edited locally needs this before its first commit.
pub fn configure(doc: &LoroDoc) {
    crate::configure_commits(doc);
}

/// A link that passed validation.
struct Parsed {
    token: String,
    project_id: String,
    secret: String,
    edit: bool,
    added_at: i64,
}

fn number(value: &LoroValue) -> Option<i64> {
    match value {
        LoroValue::I64(v) => Some(*v),
        LoroValue::Double(v) if v.is_finite() => Some(*v as i64),
        _ => None,
    }
}

fn str_of(value: &LoroValue) -> Option<&str> {
    match value {
        LoroValue::String(s) => Some(s.as_str()),
        _ => None,
    }
}

fn plain(map: &LoroMap, key: &str) -> Option<LoroValue> {
    map.get(key)?.into_value().ok()
}

/// Why a candidate link is unusable, if it is.
fn check_link(token: &str, project_id: &str, secret: &str, edit: bool) -> Result<(), &'static str> {
    if !token::looks_valid(token) {
        return Err("token");
    }
    if project_id.is_empty() {
        return Err("project id");
    }
    let parsed = LinkSecret::from_base64url(secret).map_err(|_| "secret")?;
    if edit && !parsed.can_attest() {
        return Err("edit flag on a view secret");
    }
    Ok(())
}

fn parse_link(token: &str, value: &LoroValue) -> Option<Parsed> {
    let LoroValue::Map(map) = value else {
        return None;
    };
    let project_id = str_of(map.get(link::PROJECT_ID)?)?;
    let secret = str_of(map.get(link::SECRET)?)?;
    let LoroValue::Bool(edit) = map.get(link::EDIT)? else {
        return None;
    };
    check_link(token, project_id, secret, *edit).ok()?;
    Some(Parsed {
        token: token.to_owned(),
        project_id: project_id.to_owned(),
        secret: secret.to_owned(),
        edit: *edit,
        added_at: number(map.get(link::ADDED_AT)?)?,
    })
}

fn not_future(added_at: i64, now: i64) -> bool {
    added_at <= now.saturating_add(FUTURE_SLACK_MS)
}

/// Valid links, skipping ones dated in the future.
fn valid_links(doc: &LoroDoc, now: i64) -> Vec<Parsed> {
    let map = doc.get_map(root::LINKS);
    let mut out = Vec::new();
    map.for_each(|token, value| {
        if let Some(value) = value.into_value().ok().as_ref()
            && let Some(parsed) = parse_link(token, value)
            && not_future(parsed.added_at, now)
        {
            out.push(parsed);
        }
    });
    out
}

fn retired_map(doc: &LoroDoc) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    doc.get_map(root::RETIRED).for_each(|token, value| {
        if let Some(at) = value.into_value().ok().as_ref().and_then(number) {
            out.insert(token.to_owned(), at);
        }
    });
    out
}

/// Picks the link to open a project with among its valid `links`. A link
/// that is not retired always beats one that is. Among live links an edit
/// link wins, then the newest, then the smaller token so the choice is
/// total. If every link is retired the newest one is picked, so the caller
/// can still try to catch up. `generation` is not ranked on: an attacker
/// could set any value.
fn pick<'a>(links: &[&'a Parsed], retired: &BTreeMap<String, i64>) -> Option<&'a Parsed> {
    let live = links
        .iter()
        .copied()
        .filter(|l| !retired.contains_key(&l.token));
    live.min_by(|a, b| (b.edit, b.added_at, &a.token).cmp(&(a.edit, a.added_at, &b.token)))
        .or_else(|| {
            links
                .iter()
                .copied()
                .min_by(|a, b| (b.added_at, b.edit, &a.token).cmp(&(a.added_at, a.edit, &b.token)))
        })
}

fn link_ref(l: &Parsed, retired: &BTreeMap<String, i64>) -> LinkRef {
    LinkRef {
        token: l.token.clone(),
        secret: l.secret.clone(),
        edit: l.edit,
        retired: retired.contains_key(&l.token),
    }
}

/// The best link of a project, see [`pick`] for the order.
pub fn best_link(doc: &LoroDoc, project_id: &str, now: i64) -> Option<LinkRef> {
    let links = valid_links(doc, now);
    let retired = retired_map(doc);
    let mine: Vec<&Parsed> = links
        .iter()
        .filter(|l| l.project_id == project_id)
        .collect();
    pick(&mine, &retired).map(|l| link_ref(l, &retired))
}

/// The project a share token belongs to, if its link entry is valid.
pub fn project_of_token(doc: &LoroDoc, token: &str, now: i64) -> Option<String> {
    let value = doc.get_map(root::LINKS).get(token)?.into_value().ok()?;
    parse_link(token, &value)
        .filter(|l| not_future(l.added_at, now))
        .map(|l| l.project_id)
}

struct Status {
    state: State,
    token: Option<String>,
}

fn read_status(doc: &LoroDoc, project_id: &str) -> Option<Status> {
    let value = plain(&doc.get_map(root::STATUS), project_id)?;
    let LoroValue::Map(map) = value else {
        return None;
    };
    let state = State::parse(str_of(map.get(status::STATE)?)?)?;
    Some(Status {
        state,
        token: map.get(status::TOKEN).and_then(str_of).map(str::to_owned),
    })
}

fn effective_state(status: Option<&Status>, best: &Parsed) -> State {
    let Some(status) = status else {
        return State::Listed;
    };
    match status.state {
        State::Listed => State::Listed,
        State::Forgotten => State::Forgotten,
        // A newer link learned later supersedes what an older one saw.
        State::Removed | State::Gone if status.token.as_deref() == Some(&best.token) => {
            status.state
        }
        State::Removed | State::Gone => State::Listed,
    }
}

/// Every project with at least one valid link, most recently opened first,
/// then the most recently learned, then by id. Forgotten ones are included;
/// callers filter.
pub fn list(doc: &LoroDoc, now: i64) -> Vec<Entry> {
    let links = valid_links(doc, now);
    let retired = retired_map(doc);
    let mut by_project: BTreeMap<&str, Vec<&Parsed>> = BTreeMap::new();
    for l in &links {
        by_project.entry(&l.project_id).or_default().push(l);
    }
    let titles = doc.get_map(root::TITLES);
    let opened = doc.get_map(root::OPENED);

    let mut entries: Vec<Entry> = by_project
        .into_iter()
        .filter_map(|(project_id, mine)| {
            let best = pick(&mine, &retired)?;
            let title = string_value(titles.get(project_id))
                .and_then(|t| normalize_title(&t).map(str::to_owned));
            Some(Entry {
                project_id: project_id.to_owned(),
                title,
                link: link_ref(best, &retired),
                state: effective_state(read_status(doc, project_id).as_ref(), best),
                opened_at: plain(&opened, project_id).as_ref().and_then(number),
                added_at: mine.iter().map(|l| l.added_at).min()?,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.opened_at
            .cmp(&a.opened_at)
            .then(b.added_at.cmp(&a.added_at))
            .then(a.project_id.cmp(&b.project_id))
    });
    entries
}

fn commit(doc: &LoroDoc, message: &str) {
    doc.set_next_commit_message(message);
    doc.commit();
}

/// `existing` with `fields` set on top. Unknown keys of a value written by
/// a newer client survive a rewrite this way.
fn with_fields(existing: Option<LoroValue>, fields: &[(&str, LoroValue)]) -> LoroValue {
    let mut map: HashMap<String, LoroValue> = match existing {
        Some(LoroValue::Map(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => HashMap::new(),
    };
    for (k, v) in fields {
        map.insert((*k).to_owned(), v.clone());
    }
    LoroValue::from(map)
}

fn ms(value: i64) -> LoroValue {
    // Doubles, like every number the browser writes.
    LoroValue::from(value as f64)
}

/// Records a link. Facts about a token never change: a token already
/// present only gets its `generation` filled in if it had none. Returns
/// whether anything was written.
pub fn add_link(doc: &LoroDoc, new: &NewLink) -> Result<bool, DirectoryError> {
    check_link(new.token, new.project_id, new.secret, new.edit)
        .map_err(DirectoryError::InvalidLink)?;
    let links = doc.get_map(root::LINKS);
    let existing = plain(&links, new.token);
    let existing_ok = existing
        .as_ref()
        .and_then(|v| parse_link(new.token, v))
        .is_some();

    let value = if existing_ok {
        let Some(generation) = new.generation else {
            return Ok(false);
        };
        let has_generation = matches!(&existing, Some(LoroValue::Map(m)) if m.get(link::GENERATION).and_then(number).is_some());
        if has_generation {
            return Ok(false);
        }
        with_fields(existing, &[(link::GENERATION, ms(i64::from(generation)))])
    } else {
        let mut fields = vec![
            (link::PROJECT_ID, LoroValue::from(new.project_id)),
            (link::SECRET, LoroValue::from(new.secret)),
            (link::EDIT, LoroValue::from(new.edit)),
            (link::ADDED_AT, ms(new.added_at)),
        ];
        if let Some(generation) = new.generation {
            fields.push((link::GENERATION, ms(i64::from(generation))));
        }
        // Replacing a junk entry keeps whatever unknown keys it had.
        with_fields(existing, &fields)
    };
    links.insert(new.token, value)?;
    commit(doc, "add link");
    Ok(true)
}

/// Moves a valid link to `project_id`, keeping its secret, edit flag and
/// `addedAt`. For a token the server resolves to another project than the
/// directory filed it under: the token is fine, only the filing was wrong,
/// so retiring it would lose a working link. False when the token has no
/// valid entry or is already filed there.
pub fn refile_link(doc: &LoroDoc, token: &str, project_id: &str) -> LoroResult<bool> {
    if project_id.is_empty() {
        return Ok(false);
    }
    let links = doc.get_map(root::LINKS);
    let existing = plain(&links, token);
    let Some(parsed) = existing.as_ref().and_then(|v| parse_link(token, v)) else {
        return Ok(false);
    };
    if parsed.project_id == project_id {
        return Ok(false);
    }
    links.insert(
        token,
        with_fields(existing, &[(link::PROJECT_ID, LoroValue::from(project_id))]),
    )?;
    commit(doc, "refile link");
    Ok(true)
}

/// Marks a token retired at `now` unless it already is.
pub fn retire(doc: &LoroDoc, token: &str, now: i64) -> LoroResult<bool> {
    let retired = doc.get_map(root::RETIRED);
    if plain(&retired, token).as_ref().and_then(number).is_some() {
        return Ok(false);
    }
    retired.insert(token, ms(now))?;
    commit(doc, "retire link");
    Ok(true)
}

/// Sets the title the person sees, normalized with [`normalize_title`].
/// Titles it rejects are ignored.
pub fn set_title(doc: &LoroDoc, project_id: &str, title: &str) -> LoroResult<bool> {
    let Some(title) = normalize_title(title) else {
        return Ok(false);
    };
    let titles = doc.get_map(root::TITLES);
    if string_value(titles.get(project_id)).as_deref() == Some(title) {
        return Ok(false);
    }
    titles.insert(project_id, title)?;
    commit(doc, "set title");
    Ok(true)
}

/// Records that the project was opened at `now`, at most once per
/// [`OPENED_REFRESH_MS`].
pub fn touch_opened(doc: &LoroDoc, project_id: &str, now: i64) -> LoroResult<bool> {
    let opened = doc.get_map(root::OPENED);
    if let Some(old) = plain(&opened, project_id).as_ref().and_then(number)
        && now < old.saturating_add(OPENED_REFRESH_MS)
    {
        return Ok(false);
    }
    opened.insert(project_id, ms(now))?;
    commit(doc, "open project");
    Ok(true)
}

/// Sets what is known about a project's standing. `token` names the link
/// that saw it, which `Removed` and `Gone` need to stay scoped to.
pub fn set_status(
    doc: &LoroDoc,
    project_id: &str,
    state: State,
    now: i64,
    token: Option<&str>,
) -> LoroResult<bool> {
    let map = doc.get_map(root::STATUS);
    let existing = plain(&map, project_id);
    let current = read_status(doc, project_id);
    if let Some(c) = &current
        && c.state == state
        && c.token.as_deref() == token
    {
        return Ok(false);
    }
    let mut fields = vec![
        (status::STATE, LoroValue::from(state.as_str())),
        (status::AT, ms(now)),
    ];
    // A stale token must not outlive the state it belonged to.
    let mut base = existing;
    match token {
        Some(t) => fields.push((status::TOKEN, LoroValue::from(t))),
        None => {
            if let Some(LoroValue::Map(m)) = &base {
                let mut m: HashMap<String, LoroValue> =
                    m.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                m.remove(status::TOKEN);
                base = Some(LoroValue::from(m));
            }
        }
    }
    map.insert(project_id, with_fields(base, &fields))?;
    commit(doc, "set status");
    Ok(true)
}

/// Drops links retired more than [`RETIRED_KEEP_MS`] ago, along with their
/// `retired` marks, except that a project always keeps one link (its best
/// among the old ones). Returns how many links it removed.
pub fn prune_retired(doc: &LoroDoc, now: i64) -> LoroResult<usize> {
    let links = valid_links(doc, now);
    let retired = retired_map(doc);
    let old = |l: &Parsed| {
        retired
            .get(&l.token)
            .is_some_and(|at| now.saturating_sub(*at) > RETIRED_KEEP_MS)
    };

    let mut by_project: BTreeMap<&str, Vec<&Parsed>> = BTreeMap::new();
    for l in &links {
        by_project.entry(&l.project_id).or_default().push(l);
    }
    let mut doomed: Vec<&str> = Vec::new();
    for mine in by_project.values() {
        let mut prunable: Vec<&Parsed> = mine.iter().copied().filter(|l| old(l)).collect();
        if prunable.len() == mine.len() {
            let keep = pick(&prunable, &retired).map(|l| l.token.clone());
            prunable.retain(|l| Some(&l.token) != keep.as_ref());
        }
        doomed.extend(prunable.iter().map(|l| l.token.as_str()));
    }
    if doomed.is_empty() {
        return Ok(0);
    }
    let links_map = doc.get_map(root::LINKS);
    let retired_map = doc.get_map(root::RETIRED);
    for token in &doomed {
        links_map.delete(token)?;
        retired_map.delete(token)?;
    }
    commit(doc, "prune retired links");
    Ok(doomed.len())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn owner_key_id(project_id: &str, public_hex: &str) -> String {
    format!("{project_id}/{public_hex}")
}

/// An `ownerKeys` entry that validated: the secret derives the public key
/// in its map key, so a device cannot park a secret under another key.
struct ParsedOwnerKey {
    id: String,
    public_hex: String,
    secret: OwnerSecret,
    added_at: i64,
}

/// The project an `ownerKeys` id files its key under, and the public key.
fn split_owner_key_id(id: &str) -> Option<(&str, &str)> {
    id.rsplit_once('/')
        .filter(|(project_id, _)| !project_id.is_empty())
}

fn parse_owner_key(id: &str, value: &LoroValue) -> Option<ParsedOwnerKey> {
    let (_, public_hex) = split_owner_key_id(id)?;
    let LoroValue::Map(map) = value else {
        return None;
    };
    let secret = OwnerSecret::from_base64url(str_of(map.get(owner_key::SECRET)?)?).ok()?;
    if hex(&secret.public()) != public_hex {
        return None;
    }
    Some(ParsedOwnerKey {
        id: id.to_owned(),
        public_hex: public_hex.to_owned(),
        secret,
        added_at: number(map.get(owner_key::ADDED_AT)?)?,
    })
}

/// The valid owner keys of a project, newest first, then by key so the
/// order is total.
fn valid_owner_keys(doc: &LoroDoc, project_id: &str) -> Vec<ParsedOwnerKey> {
    let mut out = Vec::new();
    doc.get_map(root::OWNER_KEYS).for_each(|id, value| {
        // The id first: deriving a public key for every other project's
        // entries would be wasted.
        if split_owner_key_id(id).is_some_and(|(project, _)| project == project_id)
            && let Some(value) = value.into_value().ok().as_ref()
            && let Some(parsed) = parse_owner_key(id, value)
        {
            out.push(parsed);
        }
    });
    out.sort_by(|a, b| {
        b.added_at
            .cmp(&a.added_at)
            .then_with(|| a.public_hex.cmp(&b.public_hex))
    });
    out
}

/// Records an owner key secret of a project so the person's other devices
/// can rotate its links. One entry per secret, never overwritten: what a
/// secret is does not change. Returns whether anything was written.
///
/// Clients record only the owner key the server currently names (the
/// group's current owner secret, or the record's), never the whole set they
/// hold, so an old key cannot be re-planted after pruning.
pub fn add_owner_key(
    doc: &LoroDoc,
    project_id: &str,
    secret: &OwnerSecret,
    now: i64,
) -> LoroResult<bool> {
    let id = owner_key_id(project_id, &hex(&secret.public()));
    let map = doc.get_map(root::OWNER_KEYS);
    let existing = plain(&map, &id);
    if existing
        .as_ref()
        .and_then(|v| parse_owner_key(&id, v))
        .is_some()
    {
        return Ok(false);
    }
    // Replacing a junk entry keeps whatever unknown keys it had.
    map.insert(
        &id,
        with_fields(
            existing,
            &[
                (
                    owner_key::SECRET,
                    LoroValue::from(secret.to_base64url().as_str()),
                ),
                (owner_key::ADDED_AT, ms(now)),
            ],
        ),
    )?;
    commit(doc, "add owner key");
    Ok(true)
}

/// Whether `secret` is recorded for the project, i.e. [`add_owner_key`]
/// would write nothing.
pub fn has_owner_key(doc: &LoroDoc, project_id: &str, secret: &OwnerSecret) -> bool {
    let id = owner_key_id(project_id, &hex(&secret.public()));
    plain(&doc.get_map(root::OWNER_KEYS), &id).is_some_and(|v| parse_owner_key(&id, &v).is_some())
}

/// A project's owner keys as `(public key hex, secret)`, newest first,
/// skipping ones dated in the future. Secrets stay out of `Debug`, so the
/// result can be logged.
pub fn owner_keys(doc: &LoroDoc, project_id: &str, now: i64) -> Vec<(String, OwnerSecret)> {
    valid_owner_keys(doc, project_id)
        .into_iter()
        .filter(|k| not_future(k.added_at, now))
        .map(|k| (k.public_hex, k.secret))
        .collect()
}

/// Keeps the newest `keep` owner keys of a project and deletes the rest,
/// since every rotation adds one. Future-dated entries count as the oldest,
/// so planting them cannot push real keys out. Returns how many it removed.
pub fn prune_owner_keys(
    doc: &LoroDoc,
    project_id: &str,
    keep: usize,
    now: i64,
) -> LoroResult<usize> {
    let (mut all, future): (Vec<_>, Vec<_>) = valid_owner_keys(doc, project_id)
        .into_iter()
        .partition(|k| not_future(k.added_at, now));
    all.extend(future);
    let Some(doomed) = all.get(keep..).filter(|d| !d.is_empty()) else {
        return Ok(0);
    };
    let map = doc.get_map(root::OWNER_KEYS);
    for key in doomed {
        map.delete(&key.id)?;
    }
    commit(doc, "prune owner keys");
    Ok(doomed.len())
}

#[cfg(test)]
mod tests;
