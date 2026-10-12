use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tokio_util::io::ReaderStream;

use super::{AppError, AppState};
use crate::store::blobs;
use crate::store::spaces::{self, Permission};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
// Blobs are client-encrypted and always served as octet-stream, but they
// are still attacker-chosen bytes on our own origin. Should a browser ever
// sniff one into something renderable, this keeps it from running script
// as the app.
const SANDBOX_CSP: &str =
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

#[derive(Debug, Serialize)]
pub struct Uploaded {
    hash: String,
    size: u64,
}

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

    let stored = state.blobs.write(body.into_data_stream()).await?;

    // The hash names the ciphertext, the only form the server ever sees.
    // Clients keep the plaintext's metadata inside the encrypted doc.
    let hash = stored.hash();
    blobs::record(&state.db, &space_id, &hash, stored.size).await?;
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
