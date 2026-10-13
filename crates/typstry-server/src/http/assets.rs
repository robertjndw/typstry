use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use tokio_util::io::ReaderStream;

use super::{AppError, AppState};
use crate::store::blobs::{self, WriteError};
use crate::store::spaces::{self, Permission};

/// The URL carries a share token, so shared caches must not keep the
/// response; the browser may, for good, since the hash names the content.
const IMMUTABLE: &str = "private, max-age=31536000, immutable";

/// An upload that sends nothing for this long is dropped. Uploads get no
/// overall deadline (a 25 MiB body on a slow link takes minutes), so this
/// is what stops a client trickling a byte now and then from holding a
/// socket and a scratch file forever.
pub const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

// Blobs are served as octet-stream, but they are still attacker-chosen bytes
// on our own origin. If a browser ever sniffs one into something renderable,
// this keeps it from running script as the app.
const SANDBOX_CSP: &str =
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

#[derive(Debug, Serialize)]
pub struct Uploaded {
    hash: String,
    size: u64,
}

/// `POST /api/s/{token}/assets`. 413 for a file over the size limit, 507
/// once the space's quota is used up.
pub async fn upload(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<(StatusCode, Json<Uploaded>), AppError> {
    let (space_id, permission) = spaces::resolve_token(&state.db, &token)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    if permission != Permission::Write {
        return Err(StatusCode::FORBIDDEN.into());
    }

    let declared_len = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared_len.is_some_and(|len| len > state.blobs.max_size()) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE.into());
    }
    let quota = state.blobs.space_quota();
    let left = quota.saturating_sub(blobs::space_usage(&state.db, &space_id).await?);
    // Without a declared length, a full space still reads the body: only
    // then is it known whether the file was too large for any space (413).
    if declared_len.is_some_and(|len| len > left || left == 0) {
        return Err(StatusCode::INSUFFICIENT_STORAGE.into());
    }

    let body = idle_timeout(body.into_data_stream(), UPLOAD_IDLE_TIMEOUT);
    let stored = match state.blobs.write_limited(body, left).await {
        Ok(stored) => stored,
        Err(WriteError::OverLimit(_)) => return Err(StatusCode::INSUFFICIENT_STORAGE.into()),
        Err(err) => return Err(err.into()),
    };

    // The hash names the ciphertext, the only form the server ever sees.
    // Clients keep the plaintext's metadata inside the encrypted doc.
    let hash = stored.hash();
    // Only a concurrent upload to the same space can get past the check
    // above and fail this one. The file stays then, like any blob whose
    // row did not commit; it is at most one upload's worth.
    if !blobs::record(&state.db, &space_id, &hash, stored.size, quota).await? {
        return Err(StatusCode::INSUFFICIENT_STORAGE.into());
    }
    Ok((
        StatusCode::CREATED,
        Json(Uploaded {
            hash,
            size: stored.size,
        }),
    ))
}

pub async fn blob(
    State(state): State<AppState>,
    Path((token, hash)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let hex = blobs::parse_hash(&hash).ok_or(StatusCode::BAD_REQUEST)?;
    let (space_id, _) = spaces::resolve_token(&state.db, &token)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;
    let size = blobs::lookup(&state.db, &space_id, &hash)
        .await?
        .ok_or(StatusCode::NOT_FOUND)?;

    let etag = HeaderValue::from_str(&format!("\"{hash}\"")).map_err(AppError::internal)?;
    let cache_headers = [
        (header::ETAG, etag.clone()),
        (header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE)),
    ];
    if if_none_match(&headers, &hash) {
        return Ok((StatusCode::NOT_MODIFIED, cache_headers).into_response());
    }

    let file = tokio::fs::File::open(state.blobs.path(hex))
        .await
        .map_err(|err| {
            // A row without its file means the data dir was tampered with.
            tracing::error!(%err, %hash, "blob file missing");
            StatusCode::NOT_FOUND
        })?;
    Ok((
        cache_headers,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            ),
            (header::CONTENT_LENGTH, HeaderValue::from(size)),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(SANDBOX_CSP),
            ),
        ],
        // The default 4 KiB reads would mean thousands of chunks per asset.
        Body::from_stream(ReaderStream::with_capacity(file, 256 * 1024)),
    )
        .into_response())
}

/// Ends `body` with an error once it has been silent for `idle`.
fn idle_timeout<S, E>(body: S, idle: Duration) -> impl Stream<Item = Result<Bytes, String>> + Unpin
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    Box::pin(futures_util::stream::unfold(
        Some(body),
        move |body| async move {
            let mut body = body?;
            match tokio::time::timeout(idle, body.next()).await {
                Ok(Some(Ok(chunk))) => Some((Ok(chunk), Some(body))),
                Ok(Some(Err(err))) => Some((Err(err.to_string()), None)),
                Ok(None) => None,
                Err(_) => Some((Err(format!("no data for {idle:?}")), None)),
            }
        },
    ))
}

fn if_none_match(headers: &HeaderMap, hash: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|tag| tag.trim())
        .any(|tag| {
            let tag = tag.strip_prefix("W/").unwrap_or(tag);
            tag == "*" || tag.trim_matches('"') == hash
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_silent_upload_times_out() {
        let chunk = || Ok::<_, std::io::Error>(Bytes::from_static(b"ab"));
        let trickle = futures_util::stream::iter([chunk()]).chain(futures_util::stream::pending());
        let mut body = idle_timeout(trickle, UPLOAD_IDLE_TIMEOUT);
        assert!(body.next().await.unwrap().is_ok());
        let started = tokio::time::Instant::now();
        assert!(body.next().await.unwrap().is_err());
        assert_eq!(started.elapsed(), UPLOAD_IDLE_TIMEOUT);
        assert!(body.next().await.is_none());

        let done = futures_util::stream::iter([chunk(), chunk()]);
        let all: Vec<_> = idle_timeout(done, UPLOAD_IDLE_TIMEOUT).collect().await;
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn matches_if_none_match_variants() {
        let hash = format!("sha256:{}", "0".repeat(64));
        let check = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::IF_NONE_MATCH, value.parse().unwrap());
            if_none_match(&headers, &hash)
        };
        assert!(check(&format!("\"{hash}\"")));
        assert!(check(&format!("W/\"other\", \"{hash}\"")));
        assert!(check("*"));
        assert!(!check("\"other\""));
    }
}
