//! Share links: `https://host/p/<token>#<key>`, the same shape
//! `projectUrl` in `apps/web/src/project/recent.ts` builds.

use std::fmt;
use std::fmt::Write as _;

use anyhow::{Context, bail};
use typstry_wire::crypto::ProjectKey;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLink {
    /// `http(s)://host[:port]`, plus any path the app is served under.
    pub origin: String,
    pub token: String,
    /// base64url, exactly as it appears in the fragment.
    pub key: String,
}

impl ShareLink {
    pub fn parse(link: &str) -> anyhow::Result<Self> {
        let link = link.trim();
        let (rest, key) = link
            .split_once('#')
            .context("the link has no key after '#'; copy the whole link from the share dialog")?;
        let (scheme, after_scheme) = rest
            .split_once("://")
            .context("the link must start with http:// or https://")?;
        if scheme != "http" && scheme != "https" {
            bail!("unsupported link scheme {scheme:?}");
        }
        let Some((base, token)) = after_scheme.rsplit_once("/p/") else {
            bail!("not a project link: expected .../p/<token>#<key>");
        };
        let token = percent_decode(token.trim_end_matches('/'));
        if base.is_empty() || token.is_empty() || token.contains('/') {
            bail!("not a project link: expected .../p/<token>#<key>");
        }
        ProjectKey::from_base64url(key).context("the key in the link is malformed")?;
        Ok(Self {
            origin: format!("{scheme}://{base}"),
            token,
            key: key.to_owned(),
        })
    }

    pub fn new(origin: &str, token: &str, key: &str) -> Self {
        Self {
            origin: origin.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            key: key.to_owned(),
        }
    }
}

impl fmt::Display for ShareLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}/p/{}#{}",
            self.origin,
            percent_encode(&self.token),
            self.key
        )
    }
}

/// The WebSocket endpoint that belongs to an http origin.
pub fn ws_url(origin: &str) -> anyhow::Result<String> {
    let origin = origin.trim_end_matches('/');
    if let Some(rest) = origin.strip_prefix("https://") {
        Ok(format!("wss://{rest}/ws"))
    } else if let Some(rest) = origin.strip_prefix("http://") {
        Ok(format!("ws://{rest}/ws"))
    } else {
        bail!("server origin {origin:?} is not an http(s) URL")
    }
}

/// Tokens are URL-safe already; this only matters for hand-edited links.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    #[test]
    fn parses_share_links() {
        let link =
            ShareLink::parse(&format!("https://typst.example.org/p/abc_DEF-1#{KEY}")).unwrap();
        assert_eq!(link.origin, "https://typst.example.org");
        assert_eq!(link.token, "abc_DEF-1");
        assert_eq!(link.key, KEY);
        assert_eq!(
            link.to_string(),
            format!("https://typst.example.org/p/abc_DEF-1#{KEY}")
        );
        assert_eq!(ws_url(&link.origin).unwrap(), "wss://typst.example.org/ws");

        let local = ShareLink::parse(&format!("http://127.0.0.1:8787/p/tok#{KEY}")).unwrap();
        assert_eq!(ws_url(&local.origin).unwrap(), "ws://127.0.0.1:8787/ws");

        let prefixed = ShareLink::parse(&format!("https://h/typstry/p/tok/#{KEY}")).unwrap();
        assert_eq!(prefixed.origin, "https://h/typstry");
        assert_eq!(prefixed.token, "tok");
    }

    #[test]
    fn rejects_broken_links() {
        for bad in [
            "https://h/p/tok".to_owned(),
            format!("ftp://h/p/tok#{KEY}"),
            format!("https://h/x/tok#{KEY}"),
            format!("https:///p/tok#{KEY}"),
            "https://h/p/tok#short".to_owned(),
        ] {
            assert!(ShareLink::parse(&bad).is_err(), "{bad}");
        }
    }
}
