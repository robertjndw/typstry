//! The Git import relay. Projects are encrypted and built in the browser, so
//! the browser runs the Git client (isomorphic-git) and this server only
//! forwards its two read-only smart-HTTP requests to a public host. The
//! browser cannot do that itself: the CSP keeps it on this origin and Git
//! hosts send no CORS headers.
//!
//! This lets anyone make the server fetch from the internet, so it is locked
//! down: https only, an optional host allowlist, no non-public addresses
//! (checked at DNS time, so a hostname can't resolve to a private IP),
//! redirects followed by hand and re-checked, and caps on size and time.

use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt};
use reqwest::Url;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::AppState;

/// Largest request body. Upload-pack requests only list wants and haves.
const MAX_REQUEST_BYTES: usize = 1 << 20;
/// Everything from the request arriving to the last byte going out.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
/// An upstream that sends nothing for this long is cut off.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 3;
const MAX_SEGMENTS: usize = 16;
const MAX_TARGET_BYTES: usize = 2048;
pub const DEFAULT_MAX_BYTES: u64 = 200 * 1024 * 1024;

const USER_AGENT: &str = concat!("typstry/", env!("CARGO_PKG_VERSION"), " git/isomorphic");
const FORWARDED: [HeaderName; 3] = [
    header::CONTENT_TYPE,
    header::ACCEPT,
    HeaderName::from_static("git-protocol"),
];
// Same reasoning as the blob responses: upstream bytes on our own origin.
const SANDBOX_CSP: &str = "default-src 'none'; sandbox";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Template {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GitConfig {
    pub enabled: bool,
    /// Lowercase hostnames the relay may reach. Empty means any public host.
    pub hosts: Vec<String>,
    /// Largest upstream response, in bytes.
    pub max_bytes: u64,
    pub templates: Vec<Template>,
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hosts: Vec::new(),
            max_bytes: DEFAULT_MAX_BYTES,
            templates: Vec::new(),
        }
    }
}

/// Whether `host` (already lowercase) is a plain hostname fit for an
/// allowlist entry.
pub fn valid_host_entry(host: &str) -> bool {
    !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// A path inside a repo: no empty, `.` or `..` segments, no backslash (which
/// Windows reads as a separator) and no control characters.
pub fn valid_repo_subpath(path: &str) -> bool {
    path.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.contains('\\')
            && !segment.chars().any(char::is_control)
    })
}

/// Checked once at startup so a typo shows up then and not as a broken
/// button for users.
pub fn validate_templates(templates: &[Template], hosts: &[String]) -> Result<(), String> {
    for template in templates {
        let name = &template.name;
        if name.trim().is_empty() {
            return Err("a template has an empty name".into());
        }
        let url = Url::parse(&template.url)
            .map_err(|err| format!("template {name:?} has an invalid url: {err}"))?;
        if url.scheme() != "https" {
            return Err(format!("template {name:?} must use an https url"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(format!(
                "template {name:?} must not put credentials in its url"
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| format!("template {name:?} has no host in its url"))?;
        if !host_allowed(hosts, host) {
            return Err(format!(
                "template {name:?} is on {host}, which is not in TYPSTRY_GIT_HOSTS"
            ));
        }
        if let Some(path) = &template.path
            && !valid_repo_subpath(path)
        {
            return Err(format!("template {name:?} has an unsafe path {path:?}"));
        }
        if let Some(r) = &template.r#ref
            && (r.is_empty() || r.chars().any(char::is_control))
        {
            return Err(format!("template {name:?} has an invalid ref"));
        }
    }
    Ok(())
}

fn host_allowed(hosts: &[String], host: &str) -> bool {
    hosts.is_empty() || hosts.iter().any(|h| h == host)
}

/// Why a relayed request failed. The web app words its message by the
/// status each one becomes, so keep the mapping stable.
#[derive(Debug, PartialEq, Eq)]
enum RelayError {
    Malformed,
    Forbidden,
    NotFound,
    TooLarge,
    Upstream,
    Timeout,
}

impl IntoResponse for RelayError {
    fn into_response(self) -> Response {
        match self {
            Self::Malformed => StatusCode::BAD_REQUEST,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Upstream => StatusCode::BAD_GATEWAY,
            Self::Timeout => StatusCode::GATEWAY_TIMEOUT,
        }
        .into_response()
    }
}

/// The relay's settings and its outbound client.
#[derive(Clone)]
pub struct GitRelay {
    config: Arc<GitConfig>,
    client: reqwest::Client,
    scheme: &'static str,
    /// Tests reach a server on loopback.
    allow_private: bool,
}

impl GitRelay {
    pub fn new(config: &GitConfig) -> Self {
        Self {
            config: Arc::new(config.clone()),
            client: client(Some(PublicOnly)),
            scheme: "https",
            allow_private: false,
        }
    }

    /// Lets the relay talk plain http to loopback addresses. Not reachable
    /// from configuration; it exists so integration tests can run an
    /// upstream on a local port.
    #[doc(hidden)]
    pub fn allow_local_http(mut self) -> Self {
        self.client = client(None);
        self.scheme = "http";
        self.allow_private = true;
        self
    }

    /// Whether a request, or a redirect to it, may be made. Hostnames are
    /// checked again when they resolve; IP literals never resolve, so they
    /// are checked here.
    fn check_url(&self, url: &Url) -> Result<(), RelayError> {
        if url.scheme() != self.scheme || !url.username().is_empty() || url.password().is_some() {
            return Err(RelayError::Forbidden);
        }
        let name = url.host_str().ok_or(RelayError::Malformed)?;
        // The parser has already turned 0x7f.1 and 2130706433 into dotted
        // form, so a literal in any spelling parses here.
        let literal = name
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>();
        if literal.is_ok_and(|ip| !self.allow_private && !is_public(ip)) {
            return Err(RelayError::Forbidden);
        }
        if !host_allowed(&self.config.hosts, name) {
            return Err(RelayError::Forbidden);
        }
        Ok(())
    }

    /// Where a `Location` header sends us, if that place is allowed.
    fn follow(&self, from: &Url, location: &str) -> Result<Url, RelayError> {
        let next = from.join(location).map_err(|_| RelayError::Upstream)?;
        self.check_url(&next)?;
        Ok(next)
    }
}

fn client(resolver: Option<PublicOnly>) -> reqwest::Client {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("ring supports the default protocol versions")
    .with_root_certificates(roots)
    .with_no_client_auth();
    let mut builder = reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        // Followed by hand, see GitRelay::follow.
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if let Some(resolver) = resolver {
        builder = builder.dns_resolver(resolver);
    }
    builder.build().expect("static client configuration")
}

/// Whether `ip` is a place on the public internet. Everything else is this
/// machine, its network or not routable, and is never worth fetching from.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        // 0.0.0.0/8 "this network"
        || a == 0
        // 100.64.0.0/10 carrier-grade NAT
        || (a == 100 && b & 0xc0 == 64)
        // 192.0.0.0/24 IETF protocol assignments
        || (a == 192 && b == 0 && c == 0)
        // 198.18.0.0/15 benchmarking
        || (a == 198 && b & 0xfe == 18)
        // 240.0.0.0/4 reserved
        || a >= 240)
}

fn public_v6(ip: Ipv6Addr) -> bool {
    // ::ffff:a.b.c.d reaches the IPv4 address, so it is judged as that.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = ip.segments();
    // 64:ff9b::/96 (NAT64) and ::a.b.c.d (deprecated) embed an IPv4 address.
    let embedded = |hi: u16, lo: u16| {
        let [a, b] = hi.to_be_bytes();
        let [c, d] = lo.to_be_bytes();
        public_v4(Ipv4Addr::new(a, b, c, d))
    };
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return embedded(s[6], s[7]);
    }
    if s[..6] == [0; 6] && !ip.is_unspecified() && !ip.is_loopback() {
        return embedded(s[6], s[7]);
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // fc00::/7 unique local
        || s[0] & 0xfe00 == 0xfc00
        // fe80::/10 link-local, and the deprecated fec0::/10 site-local
        || s[0] & 0xffc0 == 0xfe80
        || s[0] & 0xffc0 == 0xfec0
        // 2001:db8::/32 documentation
        || (s[0] == 0x2001 && s[1] == 0x0db8))
}

/// The resolver error for a name that only points at non-public addresses.
#[derive(Debug)]
struct BlockedAddr;

impl fmt::Display for BlockedAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("host resolves to a non-public address")
    }
}

impl std::error::Error for BlockedAddr {}

/// System DNS, minus every address that is not public. Filtering here and
/// not before the request is what keeps a rebinding name from passing a
/// check and then connecting somewhere else.
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let found = tokio::net::lookup_host((name.as_str(), 0)).await?;
            let public: Vec<SocketAddr> = found.filter(|addr| is_public(addr.ip())).collect();
            if public.is_empty() {
                return Err(Box::new(BlockedAddr) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

fn is_blocked(err: &reqwest::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(err) = source {
        if err.is::<BlockedAddr>() {
            return true;
        }
        source = err.source();
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// `GET .../info/refs?service=git-upload-pack`
    Advertise,
    /// `POST .../git-upload-pack`
    UploadPack,
}

impl Kind {
    fn content_type(self) -> &'static str {
        match self {
            Self::Advertise => "application/x-git-upload-pack-advertisement",
            Self::UploadPack => "application/x-git-upload-pack-result",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Target {
    kind: Kind,
    /// `host` or `host:port`, lowercase.
    host: String,
    /// Upstream path with its leading slash, without the query.
    path: String,
}

impl Target {
    fn url(&self, scheme: &str) -> Result<Url, RelayError> {
        let query = match self.kind {
            Kind::Advertise => "?service=git-upload-pack",
            Kind::UploadPack => "",
        };
        Url::parse(&format!("{scheme}://{}{}{query}", self.host, self.path))
            .map_err(|_| RelayError::Malformed)
    }
}

/// Reads the corsProxy-style path `<host>/<repo path>/<endpoint>`. Only the
/// two upload-pack requests are known; anything else, in particular
/// receive-pack, is a 404 before the target is looked at.
fn parse_target(method: &Method, target: &str, query: Option<&str>) -> Result<Target, RelayError> {
    let (rest, kind) = if let Some(rest) = target.strip_suffix("/info/refs") {
        if method != Method::GET || query != Some("service=git-upload-pack") {
            return Err(RelayError::NotFound);
        }
        (rest, Kind::Advertise)
    } else if let Some(rest) = target.strip_suffix("/git-upload-pack") {
        if method != Method::POST {
            return Err(RelayError::NotFound);
        }
        (rest, Kind::UploadPack)
    } else {
        return Err(RelayError::NotFound);
    };
    if target.len() > MAX_TARGET_BYTES {
        return Err(RelayError::Malformed);
    }
    let mut segments = rest.split('/');
    let host = segments.next().unwrap_or_default().to_ascii_lowercase();
    let repo: Vec<&str> = segments.collect();
    if !plausible_host(&host) || repo.is_empty() || repo.len() > MAX_SEGMENTS {
        return Err(RelayError::Malformed);
    }
    // A whitelist: the path is rebuilt from these segments, so nothing that
    // could change what the URL means (`..`, `?`, `#`, `%`, `\`) gets in.
    let clean = |s: &&str| {
        !s.is_empty()
            && *s != "."
            && *s != ".."
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'~' | b'+'))
    };
    if !repo.iter().all(clean) {
        return Err(RelayError::Malformed);
    }
    let endpoint = match kind {
        Kind::Advertise => "info/refs",
        Kind::UploadPack => "git-upload-pack",
    };
    Ok(Target {
        kind,
        host,
        path: format!("/{}/{endpoint}", repo.join("/")),
    })
}

/// `name`, `name:port`, `1.2.3.4[:port]` or `[v6][:port]`. Whether the
/// address is acceptable is decided later, on the parsed URL.
fn plausible_host(host: &str) -> bool {
    let (name, port) = if let Some(rest) = host.strip_prefix('[') {
        let Some((addr, after)) = rest.split_once(']') else {
            return false;
        };
        if addr.parse::<Ipv6Addr>().is_err() {
            return false;
        }
        if after.is_empty() {
            return true;
        }
        ("a", after.strip_prefix(':'))
    } else {
        match host.split_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (host, None),
        }
    };
    valid_host_entry(name)
        && port
            .is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Templates {
    git_import: bool,
    templates: Vec<Template>,
}

/// `GET /api/templates`. Tells the web app whether to offer the feature and
/// what to offer.
pub async fn templates(State(state): State<AppState>) -> Json<Templates> {
    let config = &state.git.config;
    Json(Templates {
        git_import: config.enabled,
        templates: if config.enabled {
            config.templates.clone()
        } else {
            Vec::new()
        },
    })
}

/// `GET .../info/refs?service=git-upload-pack` and `POST .../git-upload-pack`
/// under `/api/git/<host>/<repo path>`.
pub async fn relay(
    State(state): State<AppState>,
    Path(target): Path<String>,
    method: Method,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let git = &state.git;
    if !git.config.enabled {
        return RelayError::Forbidden.into_response();
    }
    match tokio::time::timeout(
        TOTAL_TIMEOUT,
        run(git, &method, &target, query.as_deref(), &headers, body),
    )
    .await
    {
        Ok(Ok(res)) => res,
        Ok(Err(err)) => {
            tracing::debug!(?err, "git relay refused or failed");
            err.into_response()
        }
        Err(_) => RelayError::Timeout.into_response(),
    }
}

async fn run(
    git: &GitRelay,
    method: &Method,
    target: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, RelayError> {
    // Taken before the body is read, so a slow upload eats into the same
    // budget as the download instead of starting a fresh one.
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let target = parse_target(method, target, query)?;
    let mut url = target.url(git.scheme)?;
    git.check_url(&url)?;
    let payload = match target.kind {
        Kind::Advertise => Bytes::new(),
        Kind::UploadPack => to_bytes(body, MAX_REQUEST_BYTES)
            .await
            .map_err(|_| RelayError::TooLarge)?,
    };

    let mut hops = 0;
    let res = loop {
        let mut req = match target.kind {
            Kind::Advertise => git.client.get(url.clone()),
            Kind::UploadPack => git.client.post(url.clone()).body(payload.clone()),
        };
        for name in &FORWARDED {
            if let Some(value) = headers.get(name) {
                req = req.header(name, value);
            }
        }
        let res = req.send().await.map_err(|err| {
            if is_blocked(&err) {
                RelayError::Forbidden
            } else if err.is_timeout() {
                RelayError::Timeout
            } else {
                tracing::debug!(%err, "git upstream request failed");
                RelayError::Upstream
            }
        })?;
        if !res.status().is_redirection() {
            break res;
        }
        hops += 1;
        let location = res
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .filter(|_| hops <= MAX_REDIRECTS)
            .ok_or(RelayError::Upstream)?;
        url = git.follow(&url, location)?;
    };

    match res.status() {
        StatusCode::OK => {}
        // A private repo answers a stranger like a missing one, and the UI
        // says "not found or not public" for both.
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => {
            return Err(RelayError::NotFound);
        }
        _ => return Err(RelayError::Upstream),
    }
    let max = git.config.max_bytes;
    if res.content_length().is_some_and(|len| len > max) {
        return Err(RelayError::TooLarge);
    }
    // Only a Git response is passed on. Anything else (an HTML error page,
    // say) would otherwise be served from our origin under its own type.
    let expected = target.kind.content_type();
    let content_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .filter(|v| v.as_bytes().starts_with(expected.as_bytes()))
        .cloned()
        .ok_or(RelayError::Upstream)?;

    let stream = limited(Box::pin(res.bytes_stream()), max, deadline);
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(SANDBOX_CSP),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

/// Ends `body` with an error once it passes `max` bytes, has been silent for
/// [`IDLE_TIMEOUT`] or runs past `deadline`. The status line is long gone by
/// then, so the client sees a broken connection rather than a 413.
fn limited<S>(
    body: S,
    max: u64,
    deadline: Instant,
) -> impl Stream<Item = Result<Bytes, io::Error>> + Unpin
where
    S: Stream<Item = reqwest::Result<Bytes>> + Unpin,
{
    Box::pin(futures_util::stream::unfold(
        Some((body, 0u64)),
        move |state| async move {
            let (mut body, seen) = state?;
            let until = deadline.min(Instant::now() + IDLE_TIMEOUT);
            match tokio::time::timeout_at(until, body.next()).await {
                Ok(Some(Ok(chunk))) => {
                    let seen = seen + chunk.len() as u64;
                    if seen > max {
                        let err = io::Error::other("upstream response over the size limit");
                        return Some((Err(err), None));
                    }
                    Some((Ok(chunk), Some((body, seen))))
                }
                Ok(Some(Err(err))) => Some((Err(io::Error::other(err)), None)),
                Ok(None) => None,
                Err(_) => Some((Err(io::Error::other("upstream timed out")), None)),
            }
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(method: &Method, path: &str, query: Option<&str>) -> Result<Target, RelayError> {
        parse_target(method, path, query)
    }

    const SERVICE: Option<&str> = Some("service=git-upload-pack");

    #[test]
    fn parses_the_two_upload_pack_forms() {
        let t = target(&Method::GET, "GitHub.com/org/repo.git/info/refs", SERVICE).unwrap();
        assert_eq!(t.kind, Kind::Advertise);
        assert_eq!(t.host, "github.com");
        assert_eq!(t.path, "/org/repo.git/info/refs");
        assert_eq!(
            t.url("https").unwrap().as_str(),
            "https://github.com/org/repo.git/info/refs?service=git-upload-pack"
        );

        let t = target(
            &Method::POST,
            "git.example.com:8443/a/b/c/git-upload-pack",
            None,
        )
        .unwrap();
        assert_eq!(t.kind, Kind::UploadPack);
        assert_eq!(t.host, "git.example.com:8443");
        assert_eq!(
            t.url("https").unwrap().as_str(),
            "https://git.example.com:8443/a/b/c/git-upload-pack"
        );
    }

    #[test]
    fn everything_else_is_not_found() {
        for (method, path, query) in [
            (
                Method::GET,
                "h.com/o/r/info/refs",
                Some("service=git-receive-pack"),
            ),
            (Method::GET, "h.com/o/r/info/refs", None),
            (
                Method::GET,
                "h.com/o/r/info/refs",
                Some("service=git-upload-pack&x=1"),
            ),
            (Method::POST, "h.com/o/r/info/refs", SERVICE),
            (Method::POST, "h.com/o/r/git-receive-pack", None),
            (Method::GET, "h.com/o/r/git-upload-pack", None),
            (Method::POST, "h.com/o/r/HEAD", None),
            (Method::GET, "h.com/o/r", None),
        ] {
            assert_eq!(
                target(&method, path, query),
                Err(RelayError::NotFound),
                "{path}"
            );
        }
    }

    #[test]
    fn malformed_targets_are_bad_requests() {
        for path in [
            "/info/refs",
            "h.com/info/refs",
            "h.com/../etc/info/refs",
            "h.com/a/./b/info/refs",
            "h.com//a/info/refs",
            "h.com/a%20b/info/refs",
            "h.com/a?b/info/refs",
            "h.com/a#b/info/refs",
            "h.com/a\\b/info/refs",
            "user@h.com/a/info/refs",
            "h.com:/a/info/refs",
            "h.com:99999999/a/info/refs",
            "h_c.com/a/info/refs",
            "[::1/a/info/refs",
            "[nope]/a/info/refs",
        ] {
            assert_eq!(
                target(&Method::GET, path, SERVICE),
                Err(RelayError::Malformed),
                "{path}"
            );
        }
        let long = format!("h.com/{}/info/refs", "a".repeat(MAX_TARGET_BYTES));
        assert_eq!(
            target(&Method::GET, &long, SERVICE),
            Err(RelayError::Malformed)
        );
        let deep = format!("h.com/{}info/refs", "a/".repeat(MAX_SEGMENTS + 1));
        assert_eq!(
            target(&Method::GET, &deep, SERVICE),
            Err(RelayError::Malformed)
        );
    }

    #[test]
    fn ip_literal_hosts_parse() {
        let t = target(&Method::GET, "[2001:4860::1]:8080/o/r/info/refs", SERVICE).unwrap();
        assert_eq!(t.host, "[2001:4860::1]:8080");
        assert!(t.url("https").is_ok());
        assert!(target(&Method::GET, "1.2.3.4/o/r/info/refs", SERVICE).is_ok());
    }

    #[test]
    fn filters_non_public_addresses() {
        let blocked = [
            "0.0.0.0",
            "0.1.2.3",
            "127.0.0.1",
            "127.9.9.9",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "192.0.0.8",
            "198.18.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "::ffff:169.254.169.254",
            "::ffff:100.64.0.1",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
        ];
        for ip in blocked {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        let public = [
            "8.8.8.8",
            "1.1.1.1",
            "140.82.112.3",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "198.17.0.1",
            "198.20.0.1",
            "2606:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
        ];
        for ip in public {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    fn relay_with(hosts: &[&str]) -> GitRelay {
        GitRelay::new(&GitConfig {
            hosts: hosts.iter().map(|h| (*h).to_owned()).collect(),
            ..GitConfig::default()
        })
    }

    #[test]
    fn urls_are_checked_before_each_request() {
        let git = relay_with(&[]);
        let ok = |s: &str| git.check_url(&Url::parse(s).unwrap());
        assert_eq!(ok("https://github.com/o/r"), Ok(()));
        assert_eq!(ok("https://8.8.8.8/o/r"), Ok(()));
        assert_eq!(ok("http://github.com/o/r"), Err(RelayError::Forbidden));
        assert_eq!(ok("https://127.0.0.1/o/r"), Err(RelayError::Forbidden));
        assert_eq!(ok("https://[::1]/o/r"), Err(RelayError::Forbidden));
        assert_eq!(
            ok("https://[::ffff:10.0.0.1]/o/r"),
            Err(RelayError::Forbidden)
        );
        // Decimal and hex spellings are normalized by the URL parser.
        assert_eq!(ok("https://2130706433/o/r"), Err(RelayError::Forbidden));
        assert_eq!(ok("https://0x7f.1/o/r"), Err(RelayError::Forbidden));
        assert_eq!(ok("https://u:p@github.com/o/r"), Err(RelayError::Forbidden));

        let git = relay_with(&["github.com"]);
        let ok = |s: &str| git.check_url(&Url::parse(s).unwrap());
        assert_eq!(ok("https://github.com:444/o/r"), Ok(()));
        assert_eq!(ok("https://gitlab.com/o/r"), Err(RelayError::Forbidden));
    }

    #[test]
    fn redirects_are_revalidated() {
        let git = relay_with(&["github.com", "codeload.github.com"]);
        let from = Url::parse("https://github.com/o/r/info/refs?service=git-upload-pack").unwrap();
        assert_eq!(
            git.follow(&from, "/o/r2/info/refs?service=git-upload-pack")
                .unwrap()
                .as_str(),
            "https://github.com/o/r2/info/refs?service=git-upload-pack"
        );
        assert_eq!(
            git.follow(&from, "https://codeload.github.com/x")
                .unwrap()
                .host_str(),
            Some("codeload.github.com")
        );
        for location in [
            "https://evil.example/x",
            "http://github.com/x",
            "https://127.0.0.1/x",
            "//evil.example/x",
            "https://u:p@github.com/x",
        ] {
            assert_eq!(
                git.follow(&from, location),
                Err(RelayError::Forbidden),
                "{location}"
            );
        }
        let open = relay_with(&[]);
        assert_eq!(
            open.follow(&from, "https://[fd00::1]/x"),
            Err(RelayError::Forbidden)
        );
        assert_eq!(
            open.follow(&from, "https://[bad"),
            Err(RelayError::Upstream)
        );
    }

    #[test]
    fn templates_are_validated() {
        let template = |url: &str, path: Option<&str>| Template {
            name: "Thesis".into(),
            description: None,
            url: url.into(),
            r#ref: None,
            path: path.map(str::to_owned),
        };
        let hosts = vec!["github.com".to_owned()];
        let ok = |t: Template| validate_templates(&[t], &hosts);
        assert!(ok(template("https://github.com/o/r", Some("a/b"))).is_ok());
        assert!(ok(template("http://github.com/o/r", None)).is_err());
        assert!(ok(template("https://gitlab.com/o/r", None)).is_err());
        assert!(ok(template("not a url", None)).is_err());
        assert!(ok(template("https://u:p@github.com/o/r", None)).is_err());
        for path in ["", "/a", "a/", "a//b", "../a", "a/./b", "a\\b", "a\u{7}b"] {
            assert!(
                ok(template("https://github.com/o/r", Some(path))).is_err(),
                "{path:?}"
            );
        }
        let mut unnamed = template("https://github.com/o/r", None);
        unnamed.name = "  ".into();
        assert!(ok(unnamed).is_err());
        let mut empty_ref = template("https://github.com/o/r", None);
        empty_ref.r#ref = Some(String::new());
        assert!(ok(empty_ref).is_err());
        // No allowlist: any host is fine.
        assert!(validate_templates(&[template("https://gitlab.com/o/r", None)], &[]).is_ok());
    }
}
