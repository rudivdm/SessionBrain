// Bundles the page's script (web/main.ts, which imports lot-map's drawing code) into the binary.
// Bun is needed to build SessionBrain, not to run it.

use std::{env, path::PathBuf, process::Command};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("app.js");
    for watched in ["web/main.ts", "web/adapter.ts", "web/skins.ts", "web/icons.ts", "web/scope.ts", "web/ink.ts", "web/timeline.ts", "web/caption.ts", "web/types.ts", "web/index.html", "web/style.css", "web/lot-map/map.ts", "web/lot-map/text.ts", "web/lot-map/types.ts", "install/sessionbrain.svg", "web/fonts"] {
        println!("cargo:rerun-if-changed={}", root.join(watched).display());
    }
    // The rendered art (art/render.py writes it to web/art), embedded as the fonts are.
    println!("cargo:rerun-if-changed={}", root.join("web/art").display());
    let mut art: Vec<String> = std::fs::read_dir(root.join("web/art"))
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".webp")).collect())
        .unwrap_or_default();
    art.sort();
    let table: String = art
        .iter()
        .map(|n| format!("    ({n:?}, include_bytes!({:?})),\n", root.join("web/art").join(n).canonicalize().unwrap().display().to_string()))
        .collect();
    std::fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("art.rs"), format!("const ART: &[(&str, &[u8])] = &[\n{table}];\n")).unwrap();
    let bun = env::var("BUN").unwrap_or_else(|_| "bun".into());
    let status = Command::new(&bun)
        .args(["build", "web/main.ts", "--target", "browser", "--minify", "--outfile"])
        .arg(&out)
        .current_dir(&root)
        .status()
        .unwrap_or_else(|e| panic!("could not run {bun} to bundle the page (set BUN to its path): {e}"));
    assert!(status.success(), "bundling web/main.ts failed");
}
