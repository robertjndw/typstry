pub mod assets;
mod error;
pub mod git;
pub mod mls;
pub mod protocol;
pub mod relay;
pub mod spaces;

use std::path::Path;
use std::time::Duration;

use axum::Router;
use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{any, get, post};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

pub use self::error::AppError;
pub use crate::state::AppState;
use crate::ws;

/// Where the browser fetches Typst fonts from when the web app was built
/// with its default font base (`VITE_TYPST_FONT_BASE`).
pub const DEFAULT_FONT_ORIGINS: &[&str] = &["https://cdn.jsdelivr.net"];

/// Packages always come from the Typst registry.
const PACKAGE_ORIGIN: &str = "https://packages.typst.org";

/// Policy for the app pages, allowing fonts from `font_origins`. The preview
/// inserts compiler-generated SVG built from collaborators' documents into
/// the page, so inline script must never run, whatever slips past the
/// sanitizer in `svg-pages.ts`.
///
/// - `'wasm-unsafe-eval'`: the Typst compiler, renderer, tinymist and Loro
///   are all wasm.
/// - `style-src 'unsafe-inline'`: CodeMirror and the preview's typst.ts CSS
///   use `<style>` elements and style attributes. Styles cannot run script.
/// - `connect-src`: typst.ts fetches its fonts from `font_origins` (unless
///   they are hosted on this origin) and packages from the Typst registry.
///   `'self'` covers the same-origin websocket too.
/// - `object-src blob:`: Chrome shows PDFs in an iframe through its plugin
///   viewer, which `object-src` governs; the only PDFs are object URLs the
///   app made itself.
pub fn app_csp(font_origins: &[String]) -> String {
    format!(
        "default-src 'self'; \
         script-src 'self' 'wasm-unsafe-eval'; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' blob: data:; \
         font-src 'self' blob: data:; \
         media-src 'self' blob:; \
         connect-src {}; \
         worker-src 'self' blob:; \
         frame-src 'self' blob:; \
         object-src blob:; \
         base-uri 'none'; \
         form-action 'self'; \
         frame-ancestors 'none'",
        connect_src(font_origins)
    )
}

/// Policy for the Typst compiler worker, which runs under its own CSP. The
/// typst.ts compiler builds functions from strings (wasm-bindgen's
/// `Function` import), so it needs `'unsafe-eval'`. It never touches a DOM
/// and only fetches its wasm, fonts and packages, so that is all it gets.
pub fn compile_worker_csp(font_origins: &[String]) -> String {
    format!(
        "default-src 'none'; \
         script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; \
         connect-src {}",
        connect_src(font_origins)
    )
}

fn connect_src(font_origins: &[String]) -> String {
    let mut sources = vec!["'self'"];
    sources.extend(font_origins.iter().map(String::as_str));
    sources.push(PACKAGE_ORIGIN);
    sources.join(" ")
}

/// Whether `origin` is a plain `http(s)://host[:port]` that can go into a
/// CSP source list as is: no path, quotes, wildcards or separators.
pub fn valid_font_origin(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
    else {
        return false;
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && port.is_none_or(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}

/// The two page policies, rendered once at startup.
#[derive(Debug, Clone)]
pub struct Csp {
    app: HeaderValue,
    compile_worker: HeaderValue,
}

impl Csp {
    /// `font_origins` must have passed [`valid_font_origin`].
    pub fn new(font_origins: &[String]) -> Self {
        let value = |policy: String| {
            HeaderValue::try_from(policy).expect("font origins are validated in config")
        };
        Self {
            app: value(app_csp(font_origins)),
            compile_worker: value(compile_worker_csp(font_origins)),
        }
    }
}

pub fn default_font_origins() -> Vec<String> {
    DEFAULT_FONT_ORIGINS.iter().map(|&o| o.to_owned()).collect()
}

/// Vite emits the worker as `assets/compile.worker-<hash>.js`.
fn is_compile_worker(path: &str) -> bool {
    path.strip_prefix("/assets/compile.worker-")
        .is_some_and(|rest| rest.ends_with(".js") && !rest.contains('/'))
}

async fn page_csp(State(csp): State<Csp>, req: Request, next: Next) -> Response {
    let policy = if is_compile_worker(req.uri().path()) {
        csp.compile_worker
    } else {
        csp.app
    };
    let mut res = next.run(req).await;
    res.headers_mut()
        .insert(header::CONTENT_SECURITY_POLICY, policy);
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
        .route("/api/templates", get(git::templates))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::SERVICE_UNAVAILABLE,
            API_TIMEOUT,
        ));
    // Uploads get no overall timeout: a 25 MB body on a slow link
    // legitimately takes minutes. The size cap bounds what one can cost,
    // and an idle timeout on the body (see assets::upload) what a stalled
    // one can hold.
    let gated = Router::new()
        .merge(api)
        // Same for the Git relay, which has its own 120 s deadline (see
        // git::relay).
        .route("/api/git/{*target}", any(git::relay))
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
                .layer(middleware::from_fn_with_state(state.csp.clone(), page_csp))
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
    .layer(TraceLayer::new_for_http().make_span_with(request_span))
    .with_state(state)
}

/// The span every request's logs carry. Share tokens travel in URL paths
/// (`/api/s/{token}/...`, `/api/share/{token}`) and the relay claim in the
/// query, so only the route pattern is recorded, never the URI, whatever
/// the log level.
fn request_span<B>(req: &axum::http::Request<B>) -> tracing::Span {
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or("(static)", MatchedPath::as_str);
    tracing::info_span!("request", method = %req.method(), route)
}

async fn healthz() -> &'static str {
    "ok"
}
