//! Header-audit coverage harness for `apple-vision`.
//!
//! This suite keeps the crate aligned with the current macOS Vision SDK by
//! checking three things:
//! 1. `COVERAGE.md` accounts for every current `VN*Request` and
//!    `VN*Observation` interface (plus a few legacy / renamed symbols the
//!    release notes call out explicitly).
//! 2. Types marked as fully implemented in `COVERAGE.md` have a real source-level
//!    footprint in the Rust crate and/or Swift bridge.
//! 3. The Swift bridge stays split into sub-500-line logical-area files and our
//!    public examples/docs avoid temporary-path usage.

#![allow(clippy::cast_precision_loss, clippy::iter_on_single_items)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CoverageStatus {
    Implemented,
    Partial,
    Skipped,
}

#[derive(Debug)]
struct CoverageRow {
    symbol: String,
    status: CoverageStatus,
    note: String,
}

fn sdk_root() -> PathBuf {
    let out = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .expect("xcrun");
    assert!(out.status.success());
    PathBuf::from(String::from_utf8(out.stdout).unwrap().trim().to_string())
}

fn manifest_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn collect_files(dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_files(&path, extension, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some(extension) {
            out.push(path);
        }
    }
}

fn read_bridge() -> String {
    let dir = manifest_root().join("swift-bridge/Sources/VisionBridge");
    let mut files = Vec::new();
    collect_files(&dir, "swift", &mut files);
    files.sort();
    files
        .into_iter()
        .map(|path| read(&path))
        .collect::<Vec<_>>()
        .join("\n")
}

fn read_rust_and_docs() -> String {
    let root = manifest_root();
    let mut rust_files = Vec::new();
    collect_files(&root.join("src"), "rs", &mut rust_files);
    rust_files.sort();

    let mut parts = rust_files
        .into_iter()
        .map(|path| read(&path))
        .collect::<Vec<_>>();
    parts.push(read(&root.join("README.md")));
    parts.push(read(&root.join("CHANGELOG.md")));
    parts.join("\n")
}

fn all_source_text() -> String {
    format!("{}\n{}", read_bridge(), read_rust_and_docs())
}

fn all_headers_text() -> String {
    let dir = sdk_root().join("System/Library/Frameworks/Vision.framework/Headers");
    let mut headers = Vec::new();
    collect_files(&dir, "h", &mut headers);
    headers.sort();
    headers
        .into_iter()
        .map(|path| read(&path))
        .collect::<Vec<_>>()
        .join("\n")
}

fn sdk_request_types() -> BTreeSet<String> {
    let re = regex_lite::Regex::new(r"@interface\s+(VN[A-Za-z0-9_]+Request)\b").unwrap();
    re.captures_iter(&all_headers_text())
        .map(|caps| caps[1].to_string())
        .collect()
}

fn sdk_observation_types() -> BTreeSet<String> {
    let re = regex_lite::Regex::new(r"@interface\s+(VN[A-Za-z0-9_]*Observation)\b").unwrap();
    re.captures_iter(&all_headers_text())
        .map(|caps| caps[1].to_string())
        .collect()
}

fn extract_interface(header_blob: &str, type_name: &str) -> String {
    let needle = regex_lite::Regex::new(&format!(r"@interface\s+{type_name}\b")).unwrap();
    let Some(start) = needle.find(header_blob) else {
        return String::new();
    };
    let rest = &header_blob[start.start()..];
    let Some(end_off) = rest.find("@end") else {
        return rest.to_string();
    };
    rest[..end_off].to_string()
}

fn extract_member_surface(interface_body: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();

    let method_re =
        regex_lite::Regex::new(r"(?m)^\s*[+\-]\s*\([^\)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    for caps in method_re.captures_iter(interface_body) {
        out.insert(caps[1].to_string());
    }

    let prop_re = regex_lite::Regex::new(
        r"(?m)^\s*@property\s*(?:\([^\)]*\))?\s*[^;]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:NS_|API_|;)",
    )
    .unwrap();
    for caps in prop_re.captures_iter(interface_body) {
        out.insert(caps[1].to_string());
    }

    let getter_re = regex_lite::Regex::new(r"getter\s*=\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    for caps in getter_re.captures_iter(interface_body) {
        out.insert(caps[1].to_string());
    }

    out
}

fn swift_aliases() -> BTreeMap<&'static str, &'static str> {
    [
        ("initWithCGImage", "(cgImage:"),
        ("initWithCVPixelBuffer", "(cvPixelBuffer:"),
        ("initWithCIImage", "(ciImage:"),
        ("initWithURL", "(url:"),
        ("initWithData", "(data:"),
        ("initWithCMSampleBuffer", "(sampleBuffer:"),
        ("initWithTargetedCGImage", "(targetedCGImage:"),
        ("initWithTargetedCIImage", "(targetedCIImage:"),
        ("initWithTargetedCVPixelBuffer", "(targetedCVPixelBuffer:"),
        ("initWithTargetedCMSampleBuffer", "(targetedCMSampleBuffer:"),
        ("initWithTargetedImageData", "(targetedImageData:"),
        ("initWithTargetedImageURL", "(targetedImageURL:"),
        (
            "initWithDetectedObjectObservation",
            "(detectedObjectObservation:",
        ),
        ("initWithRectangleObservation", "(rectangleObservation:"),
        ("initWithFrameAnalysisSpacing", "(frameAnalysisSpacing:"),
        ("initWithModel", "(model:"),
        (
            "supportedRecognitionLanguagesAndReturnError",
            "supportedRecognitionLanguages",
        ),
        ("supportedJointNamesAndReturnError", "supportedJointNames"),
        (
            "supportedJointsGroupNamesAndReturnError",
            "supportedJointsGroupNames",
        ),
        ("supportedSymbologiesAndReturnError", "supportedSymbologies"),
        (
            "supportedOutputPixelFormatsAndReturnError",
            "supportedOutputPixelFormats",
        ),
        ("supportedIdentifiersAndReturnError", "supportedIdentifiers"),
        (
            "recognizedPointsForJointsGroupName",
            "recognizedPoints(forGroupKey:",
        ),
        (
            "recognizedPointsForGroupKey",
            "recognizedPoints(forGroupKey:",
        ),
        ("recognizedPointForJointName", "recognizedPoint("),
        ("recognizedPointForKey", "recognizedPoint("),
        ("observationWithRequestRevision", "(requestRevision:"),
        ("faceObservationWithRequestRevision", "(requestRevision:"),
        (
            "rectangleObservationWithRequestRevision",
            "(requestRevision:",
        ),
    ]
    .into_iter()
    .collect()
}

fn references_in_source(source: &str, symbols: &BTreeSet<String>) -> BTreeSet<String> {
    let aliases = swift_aliases();
    symbols
        .iter()
        .filter(|name| {
            let pattern = format!(r"\b{}\b", regex_lite::escape(name));
            if regex_lite::Regex::new(&pattern).unwrap().is_match(source) {
                return true;
            }
            aliases
                .get(name.as_str())
                .is_some_and(|alias| source.contains(alias))
        })
        .cloned()
        .collect()
}

fn extract_ns_enum(header: &str, type_name: &str) -> String {
    let needle =
        regex_lite::Regex::new(&format!(r"typedef\s+NS_ENUM\s*\([^,]+,\s*{type_name}\s*\)"))
            .unwrap();
    let Some(start) = needle.find(header) else {
        return String::new();
    };
    let rest = &header[start.end()..];
    let Some(open) = rest.find('{') else {
        return String::new();
    };
    let after_open = &rest[open + 1..];
    let Some(close) = after_open.find('}') else {
        return after_open.to_string();
    };
    after_open[..close].to_string()
}

fn extract_ns_enum_cases(enum_body: &str, prefix: &str) -> BTreeSet<String> {
    let pattern = format!(r"\b{}([A-Za-z][A-Za-z0-9]*)\b", regex_lite::escape(prefix));
    let re = regex_lite::Regex::new(&pattern).unwrap();
    re.captures_iter(enum_body)
        .map(|caps| caps[1].to_string())
        .collect()
}

fn read_coverage_rows() -> BTreeMap<String, CoverageRow> {
    let text = read(&manifest_root().join("COVERAGE.md"));
    let mut rows = BTreeMap::new();

    for line in text.lines() {
        if !line.starts_with('|') {
            continue;
        }
        let cols: Vec<_> = line.split('|').map(str::trim).collect();
        if cols.len() < 5 {
            continue;
        }
        let symbol = cols[1];
        let status_cell = cols[2];
        let note = cols[3];
        if symbol.is_empty() || symbol == "Symbol" || symbol.starts_with("---") {
            continue;
        }
        let status = if status_cell.starts_with('✅') {
            CoverageStatus::Implemented
        } else if status_cell.starts_with('🟡') {
            CoverageStatus::Partial
        } else if status_cell.starts_with('⏭') {
            CoverageStatus::Skipped
        } else {
            panic!("unrecognised coverage status '{status_cell}' on row '{line}'");
        };
        let row = CoverageRow {
            symbol: symbol.to_string(),
            status,
            note: note.to_string(),
        };
        assert!(
            rows.insert(symbol.to_string(), row).is_none(),
            "duplicate COVERAGE.md row for {symbol}"
        );
    }

    rows
}

#[test]
fn coverage_markdown_accounts_for_current_sdk_and_requested_aliases() {
    let rows = read_coverage_rows();
    let mut expected = sdk_request_types();
    expected.extend(sdk_observation_types());
    expected.extend(
        [
            "VNAnimalDetectionRequest",
            "VNDetectImageAestheticsScoresRequest",
            "VNTrajectoryRequest",
        ]
        .into_iter()
        .map(String::from),
    );

    for symbol in expected {
        assert!(
            rows.contains_key(&symbol),
            "{symbol} missing from COVERAGE.md"
        );
    }
}

#[test]
fn implemented_rows_reference_sdk_surface_from_source() {
    let headers = all_headers_text();
    let source = all_source_text();

    for row in read_coverage_rows().values() {
        if row.status != CoverageStatus::Implemented {
            continue;
        }
        let interface_body = extract_interface(&headers, &row.symbol);
        if interface_body.is_empty() {
            continue;
        }
        let members = extract_member_surface(&interface_body);
        let refs = references_in_source(&source, &members);
        let exact = regex_lite::Regex::new(&format!(r"\b{}\b", regex_lite::escape(&row.symbol)))
            .unwrap()
            .is_match(&source);
        assert!(
            exact || !refs.is_empty(),
            "{} is marked implemented in COVERAGE.md but no matching SDK surface was found in src/ or swift-bridge/ (note: {})",
            row.symbol,
            row.note,
        );
    }
}

#[test]
fn swift_bridge_files_stay_under_500_lines() {
    let dir = manifest_root().join("swift-bridge/Sources/VisionBridge");
    let mut swift_files = Vec::new();
    collect_files(&dir, "swift", &mut swift_files);
    swift_files.sort();
    assert!(
        swift_files.len() >= 10,
        "expected split multi-file Swift bridge"
    );

    for path in swift_files {
        let lines = read(&path).lines().count();
        assert!(
            lines <= 500,
            "{} has {lines} lines; keep bridge files under the gold-standard ~500-line ceiling",
            path.display(),
        );
    }
}

#[test]
fn public_examples_and_docs_avoid_temp_paths() {
    let root = manifest_root();
    let mut offenders = Vec::new();

    let mut rust_files = Vec::new();
    collect_files(&root.join("src"), "rs", &mut rust_files);
    collect_files(&root.join("examples"), "rs", &mut rust_files);
    rust_files.push(root.join("README.md"));

    rust_files.sort();
    for path in rust_files {
        let text = read(&path);
        if text.contains("/tmp") || text.contains("temp_dir(") {
            offenders.push(path.display().to_string());
        }
    }

    assert!(
        offenders.is_empty(),
        "temporary paths found in public docs/examples: {}",
        offenders.join(", "),
    );
}

#[test]
fn vn_request_text_recognition_level_coverage() {
    let header = read(
        &sdk_root()
            .join("System/Library/Frameworks/Vision.framework/Headers/VNRecognizeTextRequest.h"),
    );
    let body = extract_ns_enum(&header, "VNRequestTextRecognitionLevel");
    let apple = extract_ns_enum_cases(&body, "VNRequestTextRecognitionLevel");
    let bridge = read_bridge();
    let ours: BTreeSet<String> = apple
        .iter()
        .filter(|case_name| {
            let lower = format!(
                "{}{}",
                case_name.chars().next().unwrap().to_ascii_lowercase(),
                &case_name[1..]
            );
            bridge.contains(&format!(".{lower}")) || bridge.contains(&format!(".{case_name}"))
        })
        .cloned()
        .collect();

    assert_eq!(apple, ours, "VNRequestTextRecognitionLevel drift detected");
}
