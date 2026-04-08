use std::{cmp::min, io::SeekFrom, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};

use crate::state::AppState;

pub async fn start_server(state: Arc<AppState>) -> anyhow::Result<u16> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD])
        .allow_headers([header::RANGE, header::CONTENT_TYPE, header::ACCEPT])
        .max_age(Duration::from_secs(3600));

    let app = Router::new()
        .route(
            "/stream/{info_hash}/{file_index}",
            get(stream_get_handler).head(stream_head_handler),
        )
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(?error, "local streaming server exited unexpectedly");
        }
    });

    Ok(port)
}

async fn stream_get_handler(
    Path((info_hash, file_index)): Path<(String, usize)>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    stream_response(info_hash, file_index, state, headers, true).await
}

async fn stream_head_handler(
    Path((info_hash, file_index)): Path<(String, usize)>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    stream_response(info_hash, file_index, state, headers, false).await
}

fn parse_range_header(
    range_header: Option<&str>,
    file_size: u64,
) -> Result<Option<(u64, u64)>, ()> {
    let Some(range_header) = range_header else {
        return Ok(None);
    };

    if file_size == 0 {
        return Err(());
    }

    let range = range_header.trim();
    if !range.starts_with("bytes=") || range.contains(',') {
        return Err(());
    }

    let (start_raw, end_raw) = range[6..].split_once('-').ok_or(())?;

    if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<u64>().map_err(|_| ())?;
        if suffix_len == 0 {
            return Err(());
        }

        let length = suffix_len.min(file_size);
        return Ok(Some((file_size - length, file_size - 1)));
    }

    let start = start_raw.parse::<u64>().map_err(|_| ())?;
    let end = if end_raw.is_empty() {
        file_size - 1
    } else {
        end_raw.parse::<u64>().map_err(|_| ())?
    };

    if start > end || start >= file_size {
        return Err(());
    }

    Ok(Some((start, min(end, file_size - 1))))
}

async fn stream_response(
    info_hash: String,
    file_index: usize,
    state: Arc<AppState>,
    headers: HeaderMap,
    include_body: bool,
) -> Response {
    let handle = match state.torrent(&info_hash) {
        Ok(handle) => handle,
        Err(error) => return (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };

    let (file_size, file_name): (u64, PathBuf) = match handle.with_metadata(|metadata| {
        metadata
            .file_infos
            .get(file_index)
            .map(|file| (file.len, file.relative_filename.clone()))
    }) {
        Ok(Some(file)) => file,
        Ok(None) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error.to_string()).into_response(),
    };

    let mime_type = mime_guess::from_path(&file_name)
        .first_raw()
        .unwrap_or("application/octet-stream");

    let has_range_request = headers.contains_key(header::RANGE);

    if file_size == 0 && !has_range_request {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, "0")
            .body(Body::empty())
            .unwrap();
    }

    let range = match parse_range_header(
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
        file_size,
    ) {
        Ok(range) => range,
        Err(()) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{file_size}"))
                .body(Body::empty())
                .unwrap();
        }
    };

    let (start, end, status) = match range {
        Some((start, end)) => (start, end, StatusCode::PARTIAL_CONTENT),
        None => (0, file_size - 1, StatusCode::OK),
    };
    let content_length = end - start + 1;

    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, content_length.to_string());

    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{file_size}"),
        );
    }

    if !include_body {
        return response.body(Body::empty()).unwrap();
    }

    let mut stream = match handle.stream(file_index) {
        Ok(stream) => stream,
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
        }
    };

    if let Err(error) = stream.seek(SeekFrom::Start(start)).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }

    let body = Body::from_stream(ReaderStream::with_capacity(
        stream.take(content_length),
        64 * 1024,
    ));

    response.body(body).unwrap()
}
