//! Analyse de la machine pour recommander un modèle local : RAM, cœurs CPU
//! (sysinfo), GPU et VRAM dédiée (DXGI), espace disque libre.

use serde_json::{json, Value};
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Manager};

pub fn scan(app: &AppHandle) -> Result<Value, String> {
    let sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_memory(MemoryRefreshKind::everything())
            .with_cpu(CpuRefreshKind::nothing()),
    );
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();

    // Disque qui héberge les modèles Ollama (profil utilisateur par défaut).
    let target = std::env::var_os("OLLAMA_MODELS")
        .map(std::path::PathBuf::from)
        .or_else(|| app.path().home_dir().ok())
        .unwrap_or_default();
    let disks = Disks::new_with_refreshed_list();
    let free_disk = disks
        .list()
        .iter()
        .filter(|d| target.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .or_else(|| disks.list().first())
        .map(|d| d.available_space());

    Ok(json!({
        "totalRam": sys.total_memory(),
        "availableRam": sys.available_memory(),
        "cpuCores": sys.physical_core_count(),
        "cpuThreads": sys.cpus().len(),
        "cpuBrand": cpu_brand,
        "gpus": gpus(),
        "freeDisk": free_disk,
    }))
}

#[cfg(windows)]
fn gpus() -> Vec<Value> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return out;
        };
        let mut i = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let Ok(desc) = adapter.GetDesc1() else { continue };
            if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..len]);
            let vendor = match desc.VendorId {
                0x10DE => "nvidia",
                0x1002 | 0x1022 => "amd",
                0x8086 => "intel",
                0x5143 => "qualcomm",
                _ => "other",
            };
            out.push(json!({
                "name": name.trim(),
                "vendor": vendor,
                "vram": desc.DedicatedVideoMemory as u64,
                "sharedMemory": desc.SharedSystemMemory as u64,
            }));
        }
    }
    // Le GPU le mieux doté en premier.
    out.sort_by_key(|g| std::cmp::Reverse(g["vram"].as_u64().unwrap_or(0)));
    out
}

#[cfg(not(windows))]
fn gpus() -> Vec<Value> {
    Vec::new()
}
