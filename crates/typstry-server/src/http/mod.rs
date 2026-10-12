pub mod assets;
mod error;
pub mod mls;
pub mod protocol;
pub mod relay;
pub mod spaces;

use std::path::Path;
use std::time::Duration;

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

pub use self::error::AppError;
pub use crate::state::AppState;
use crate::ws;

/// Policy for the app pages. The preview inserts compiler-generated SVG
/// built from collaborators' documents into the page, so inline script must
/// never run, whatever slips past the sanitizer in `svg-pages.ts`.
///
/// - `'wasm-unsafe-eval'`: the Typst compiler, renderer, tinymist and Loro
///   are all wasm.
/// - `style-src 'unsafe-inline'`: CodeMirror and the preview's typst.ts CSS
///   use `<style>` elements and style attributes. Styles cannot run script.
/// - `connect-src`: typst.ts fetches its default fonts from jsdelivr and
///   packages from the Typst registry. `'self'` covers the same-origin
///   websocket too.
/// - `object-src blob:`: Chrome shows PDFs in an iframe through its plugin
///   viewer, which `object-src` governs; the only PDFs are object URLs the
///   app made itself.
pub const APP_CSP: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self' 'wasm-unsafe-eval'; ",
    "style-src 'self' 'unsafe-inline'; ",
    "img-src 'self' blob: data:; ",
    "font-src 'self' blob: data:; ",
    "media-src 'self' blob:; ",
    "connect-src 'self' https://cdn.jsdelivr.net https://packages.typst.org; ",
    "worker-src 'self' blob:; ",
    "frame-src 'self' blob:; ",
    "object-src blob:; ",
    "base-uri 'none'; ",
    "form-action 'self'; ",
    "frame-ancestors 'none'",
);

/// Policy for the Typst compiler worker, which runs under its own CSP. The
/// typst.ts compiler builds functions from strings (wasm-bindgen's
/// `Function` import), so it needs `'unsafe-eval'`. It never touches a DOM
/// and only fetches its wasm, fonts and packages, so that is all it gets.
pub const COMPILE_WORKER_CSP: &str = concat!(
    "default-src 'none'; ",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; ",
    "connect-src 'self' https://cdn.jsdelivr.net https://packages.typst.org",
);

/// Vite emits the worker as `assets/compile.worker-<hash>.js`.
fn is_compile_worker(path: &str) -> bool {
    path.strip_prefix("/assets/compile.worker-")
        .is_some_and(|rest| rest.ends_with(".js") && !rest.contains('/'))
}

async fn app_csp(req: Request, next: Next) -> Response {
    let policy = if is_compile_worker(req.uri().path()) {
        COMPILE_WORKER_CSP
    } else {
        APP_CSP
    };
    let mut res = next.run(req).await;
    res.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(policy),
    );
    res
}

/// Vite puts a content hash in every file name under `/assets/`, so those
/// files never change and the browser can keep them forever. The compiler and
/// tinymist wasm are tens of megabytes, too big to revalidate on every visit.
/// Pages are always revalidated, otherwise a deploy keeps serving the old
/// `index.html` with its stale asset names.
async fn cache_control(req: Request, next: Next) -> Response {
    let hashed = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    // A missing asset falls back to index.html with a 200; caching that
    // forever would pin the page under the asset's name.
    let is_html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"text/html"));
    let policy = if hashed && res.status() == StatusCode::OK && !is_html {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    res
}

/// Small database lookups; anything slower than this is stuck.
const API_TIMEOUT: Duration = Duration::from_secs(10);

pub fn router(state: AppState, web_dist: &Path) -> Router {
    let api = Router::new()
        .route("/api/spaces", post(spaces::create))
        .route("/api/share/{token}", get(spaces::share))
        .route(typstry_wire::relay::RELAY_API_PATH, post(relay::allocate))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::SERVICE_UNAVAILABLE,
            API_TIMEOUT,
        ));
    // Uploads get no timeout: a 25 MB body on a slow link legitimately
    // takes minutes, and the size cap already bounds what one can cost.
    let gated = Router::new()
        .merge(api)
        .route("/api/s/{token}/assets", post(assets::upload))
        .route("/api/s/{token}/blobs/{hash}", get(assets::blob))
        .route("/api/s/{token}/mls", get(mls::bootstrap))
        .route("/ws", get(ws::handler))
        .route(typstry_wire::ds::DS_PATH, get(ws::mls::handler))
        .route(typstry_wire::relay::RELAY_WS_PATH, get(ws::relay::handler))
        .layer(middleware::from_fn(protocol::gate));
    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/info", get(protocol::info))
        .merge(gated);

    // In dev the Vite server serves the frontend, so a missing dist is normal.
    if web_dist.is_dir() {
        let index = web_dist.join("index.html");
        // The build writes .br and .gz next to each compressible asset (see
        // vite.config.ts); the wasm shrinks to about a third.
        let pages = ServeDir::new(web_dist)
            .precompressed_br()
            .precompressed_gzip()
            .fallback(ServeFile::new(index));
        app = app.fallback_service(
            Router::new()
                .fallback_service(pages)
                .layer(middleware::from_fn(app_csp))
                .layer(middleware::from_fn(cache_control)),
        );
    } else {
        tracing::info!(path = %web_dist.display(), "web dist not found, static serving disabled");
    }

    // if_not_present: blob responses set their own, stricter headers.
    app.layer(SetResponseHeaderLayer::if_not_present(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ))
    .layer(SetResponseHeaderLayer::if_not_present(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    ))
    .layer(TraceLayer::new_for_http())
    .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}
