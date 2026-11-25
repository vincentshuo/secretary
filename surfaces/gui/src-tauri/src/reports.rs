//! The local agent writes directly to Channel/<channel>/<report>.html.
use chrono::{DateTime, Local};
use dom_query::Document;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
pub struct Report {
    id: String,
    path: String,
    channel: String,
    title: String,
    modified: String,
    date: String,
}

#[derive(Serialize)]
pub struct Channel {
    id: String,
    name: String,
    documents: Vec<Report>,
}

struct Cached {
    modified: SystemTime,
    size: u64,
    report: Report,
}

#[derive(Default)]
struct Index {
    files: HashMap<PathBuf, Cached>,
    watcher: Option<RecommendedWatcher>,
}

pub struct Library {
    root: PathBuf,
    index: Mutex<Index>,
}

impl Library {
    pub fn local() -> Self {
        let default = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("public/youtube/Channel");
        Self {
            root: std::env::var_os("EDISON_REPORTS_DIR")
                .map(PathBuf::from)
                .unwrap_or(default),
            index: Mutex::new(Index::default()),
        }
    }
}

fn html(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("html"))
}

fn title(path: &Path) -> io::Result<String> {
    // Images are often embedded in the body. Parse only the header when possible.
    let mut input = BufReader::new(File::open(path)?);
    let mut head = Vec::new();
    loop {
        let start = head.len();
        if input.read_until(b'>', &mut head)? == 0 {
            break;
        }
        let tag = &head[start..];
        if [b"</title>".as_slice(), b"</head>", b"<body>"]
            .iter()
            .any(|end| {
                tag.len() >= end.len() && tag[tag.len() - end.len()..].eq_ignore_ascii_case(end)
            })
        {
            break;
        }
    }
    let document = Document::from(String::from_utf8_lossy(&head).as_ref());
    let text = document.select_single("title").text();
    let text = text.trim();
    Ok(if text.is_empty() {
        path.file_stem().unwrap().to_string_lossy().into_owned()
    } else {
        text.to_owned()
    })
}

#[cfg(unix)]
fn file_id(meta: &fs::Metadata, _: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    let birth = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .unwrap_or_default();
    format!("file:{}:{}:{}", meta.dev(), meta.ino(), birth.as_nanos())
}
#[cfg(not(unix))]
fn file_id(_: &fs::Metadata, path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn read_report(
    path: &Path,
    channel: &str,
    previous: &HashMap<PathBuf, Cached>,
) -> io::Result<Cached> {
    let meta = fs::symlink_metadata(path)?;
    let modified = meta.modified()?;
    let size = meta.len();
    let id = file_id(&meta, path);
    let report = match previous.get(path) {
        Some(c) if c.modified == modified && c.size == size && c.report.id == id => {
            c.report.clone()
        }
        _ => {
            let date: DateTime<Local> = modified.into();
            Report {
                id,
                path: format!(
                    "Channel/{channel}/{}",
                    path.file_name().unwrap().to_string_lossy()
                ),
                channel: channel.to_owned(),
                title: title(path)?,
                modified: date
                    .to_utc()
                    .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
                date: date.format("%Y.%m.%d").to_string(),
            }
        }
    };
    Ok(Cached {
        modified,
        size,
        report,
    })
}

fn scan(root: &Path, index: &mut Index) -> io::Result<Vec<Channel>> {
    let mut files = HashMap::new();
    let mut channels = Vec::new();
    for dir in fs::read_dir(root)? {
        let dir = dir?;
        if !dir.file_type()?.is_dir() {
            continue;
        }
        let name = dir.file_name().to_string_lossy().into_owned();
        let mut documents = Vec::new();
        let entries = match fs::read_dir(dir.path()) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            other => other?,
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !html(&path) || !entry.file_type()?.is_file() {
                continue;
            }
            let cached = match read_report(&path, &name, &index.files) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                other => other?,
            };
            documents.push(cached.report.clone());
            files.insert(path, cached);
        }
        channels.push(Channel {
            id: name.clone(),
            name,
            documents,
        });
    }
    channels.sort_by_key(|c| c.name.to_lowercase());
    index.files = files;
    Ok(channels)
}

#[tauri::command]
pub async fn list_local_reports(
    app: AppHandle,
    library: State<'_, Library>,
) -> Result<Vec<Channel>, String> {
    let list = || -> Result<_, Box<dyn std::error::Error>> {
        let mut index = library
            .index
            .lock()
            .map_err(|_| "report index unavailable")?;
        if index.watcher.is_none() {
            let mut watcher =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    if !matches!(event, Ok(ref e) if matches!(e.kind, EventKind::Access(_))) {
                        let _ = app.emit("reports-changed", ());
                    }
                })?;
            watcher.watch(&library.root, RecursiveMode::Recursive)?;
            index.watcher = Some(watcher);
        }
        Ok(scan(&library.root, &mut index)?)
    };
    list().map_err(|e| format!("{}: {e}", library.root.display()))
}

fn report_path(root: &Path, path: &str) -> io::Result<PathBuf> {
    let parts: Vec<_> = Path::new(path).components().collect();
    if let [Component::Normal(prefix), Component::Normal(channel), Component::Normal(file)] =
        parts.as_slice()
    {
        let root = root.canonicalize()?;
        let path = root.join(channel).join(file);
        if *prefix == "Channel" && html(&path) && path.canonicalize()? == path && path.is_file() {
            return Ok(path);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "Invalid local report",
    ))
}

#[tauri::command]
pub fn open_local_report(path: String, library: State<'_, Library>) -> Result<(), String> {
    let file = report_path(&library.root, &path).map_err(|e| e.to_string())?;
    open::that_detached(file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn agent_files_are_read_live_and_rediscovered_after_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let first = root.join("First");
        let second = root.join("Second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let mut index = Index::default();
        let (send, recv) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |ev| {
            send.send(ev).ok();
        })
        .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        let original = first.join("文章.html");
        let moved = second.join("新名.html");
        fs::write(&original, "<title>One &amp; Two</title>").unwrap();
        recv.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        let initial = scan(&root, &mut index).unwrap()[0].documents[0].clone();
        assert_eq!(initial.title, "One & Two");
        assert_eq!(report_path(&root, &initial.path).unwrap(), original);
        fs::rename(original, &moved).unwrap();
        fs::write(&moved, "<title>新的标题</title>").unwrap();
        let current = &scan(&root, &mut Index::default()).unwrap()[1].documents[0];
        assert_eq!(initial.id, current.id);
        assert_eq!(current.title, "新的标题");
        assert_eq!(
            fs::read_to_string(report_path(&root, &current.path).unwrap()).unwrap(),
            "<title>新的标题</title>"
        );
        fs::remove_file(moved).unwrap();
        assert!(scan(&root, &mut index)
            .unwrap()
            .iter()
            .all(|c| c.documents.is_empty()));
    }
}
