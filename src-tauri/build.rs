fn main() {
    let target = |key: &str| std::env::var(format!("CARGO_CFG_TARGET_{key}")).unwrap_or_default();
    let mut attributes = tauri_build::Attributes::new();

    // Windows will not start a program that uses Tauri's dialogs unless its manifest asks for
    // Common Controls 6. tauri-build puts that manifest in the app binary only, so the unit
    // tests (a separate executable with the same code linked in) die at launch with
    // STATUS_ENTRYPOINT_NOT_FOUND. Have the linker embed windows-app-manifest.xml (a copy of
    // tauri-build's default) in every executable instead, and tell tauri-build not to add a second one.
    if target("OS") == "windows" && target("ENV") == "msvc" {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
