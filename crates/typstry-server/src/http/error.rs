use std::io;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::store::blobs::WriteError;

/// A failed request. Expected outcomes carry their status; anything else is
/// logged and the client only learns that it was ours. The trace layer's
/// span already says which request it was.
#[derive(Debug)]
pub enum AppError {
    Status(StatusCode),
    Internal(String),
}

impl AppError {
    pub fn internal(err: impl std::fmt::Display) -> Self {
        Self::Internal(err.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::Status(status) => status.into_response(),
            Self::Internal(err) => {
                tracing::error!(%err, "request failed");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

impl From<StatusCode> for AppError {
    fn from(status: StatusCode) -> Self {
        Self::Status(status)
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::internal(err)
    }
}

impl From<io::Error> for AppError {
    fn from(err: io::Error) -> Self {
        Self::internal(err)
    }
}

impl From<WriteError> for AppError {
    fn from(err: WriteError) -> Self {
        match err {
            WriteError::TooLarge(_) => Self::Status(StatusCode::PAYLOAD_TOO_LARGE),
            WriteError::Body(err) => {
                tracing::debug!(%err, "upload body aborted");
                Self::Status(StatusCode::BAD_REQUEST)
            }
            WriteError::Io(err) => err.into(),
        }
    }
}
