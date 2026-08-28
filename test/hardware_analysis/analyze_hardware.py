from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

import psutil


@dataclass
class CPUInfo:
    model: str
    architecture: str
    physical_cores: Optional[int]
    logical_cores: Optional[int]
    frequency_mhz: Optional[float]
    flags: list[str] = field(default_factory=list)

    avx: bool = False
    avx2: bool = False
    sse4_1: bool = False
    sse4_2: bool = False


@dataclass
class MemoryInfo:
    total_gb: float
    available_gb: float


@dataclass
class DiskInfo:
    path: str
    total_gb: float
    free_gb: float


@dataclass
class GPUInfo:
    name: str
    vendor: Optional[str] = None
    vram_mb: Optional[int] = None

    cuda: bool = False
    vulkan: bool = False
    directml_possible: bool = False
    metal_possible: bool = False


@dataclass
class CodecCapabilities:
    ffmpeg_available: bool = False

    h264_decode: bool = False
    hevc_decode: bool = False
    av1_decode: bool = False

    h264_encode: bool = False
    hevc_encode: bool = False
    av1_encode: bool = False

    nvenc: bool = False
    qsv: bool = False
    vaapi: bool = False
    videotoolbox: bool = False
    amf: bool = False


@dataclass
class HardwareProfile:
    os: str
    os_version: str

    cpu: CPUInfo
    memory: MemoryInfo
    disks: list[DiskInfo]

    gpus: list[GPUInfo]
    codecs: CodecCapabilities

    suggested_tier: str
    notes: list[str] = field(default_factory=list)


def run_command(command: list[str]) -> str:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

        if result.returncode == 0:
            return result.stdout.strip()

    except Exception:
        pass

    return ""


def get_cpu_model() -> str:
    system = platform.system()

    if system == "Windows":
        output = run_command([
            "powershell",
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_Processor).Name",
        ])

        if output:
            return output.splitlines()[0].strip()

    elif system == "Darwin":
        output = run_command([
            "sysctl",
            "-n",
            "machdep.cpu.brand_string",
        ])

        if output:
            return output

        output = run_command([
            "sysctl",
            "-n",
            "hw.model",
        ])

        if output:
            return output

    elif system == "Linux":
        try:
            cpuinfo = Path("/proc/cpuinfo").read_text(
                encoding="utf-8",
                errors="ignore",
            )

            for line in cpuinfo.splitlines():
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()

        except Exception:
            pass

    return platform.processor() or "Unknown CPU"


def get_cpu_flags() -> list[str]:
    system = platform.system()

    if system == "Linux":
        try:
            cpuinfo = Path("/proc/cpuinfo").read_text(
                encoding="utf-8",
                errors="ignore",
            )

            for line in cpuinfo.splitlines():
                if line.lower().startswith(("flags", "features")):
                    return line.split(":", 1)[1].lower().split()

        except Exception:
            pass

    if system == "Darwin":
        output = run_command([
            "sysctl",
            "-n",
            "machdep.cpu.features",
        ])

        output += " " + run_command([
            "sysctl",
            "-n",
            "machdep.cpu.leaf7_features",
        ])

        return output.lower().split()

    # Windows CPU-feature detection is intentionally incomplete here.
    # A Rust version should use CPUID directly.
    return []


def detect_cpu() -> CPUInfo:
    flags = get_cpu_flags()

    freq = psutil.cpu_freq()

    return CPUInfo(
        model=get_cpu_model(),
        architecture=platform.machine(),
        physical_cores=psutil.cpu_count(logical=False),
        logical_cores=psutil.cpu_count(logical=True),
        frequency_mhz=freq.max if freq else None,
        flags=flags,
        avx="avx" in flags,
        avx2="avx2" in flags,
        sse4_1="sse4_1" in flags or "sse4.1" in flags,
        sse4_2="sse4_2" in flags or "sse4.2" in flags,
    )


def detect_memory() -> MemoryInfo:
    memory = psutil.virtual_memory()

    return MemoryInfo(
        total_gb=round(memory.total / (1024 ** 3), 2),
        available_gb=round(memory.available / (1024 ** 3), 2),
    )


def detect_disks() -> list[DiskInfo]:
    disks: list[DiskInfo] = []

    seen = set()

    for partition in psutil.disk_partitions(all=False):
        path = partition.mountpoint

        if path in seen:
            continue

        seen.add(path)

        try:
            usage = psutil.disk_usage(path)

            disks.append(
                DiskInfo(
                    path=path,
                    total_gb=round(
                        usage.total / (1024 ** 3),
                        2,
                    ),
                    free_gb=round(
                        usage.free / (1024 ** 3),
                        2,
                    ),
                )
            )

        except Exception:
            pass

    return disks


def gpu_vendor(name: str) -> Optional[str]:
    lower = name.lower()

    if "nvidia" in lower:
        return "NVIDIA"

    if "amd" in lower or "radeon" in lower:
        return "AMD"

    if "intel" in lower:
        return "Intel"

    if "apple" in lower:
        return "Apple"

    return None


def detect_nvidia_gpus() -> list[GPUInfo]:
    if shutil.which("nvidia-smi") is None:
        return []

    output = run_command([
        "nvidia-smi",
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
    ])

    gpus = []

    for line in output.splitlines():
        if not line.strip():
            continue

        parts = [part.strip() for part in line.split(",")]

        try:
            name = parts[0]
            vram_mb = int(parts[1])

            gpus.append(
                GPUInfo(
                    name=name,
                    vendor="NVIDIA",
                    vram_mb=vram_mb,
                    cuda=True,
                    vulkan=True,
                    directml_possible=platform.system() == "Windows",
                )
            )

        except Exception:
            continue

    return gpus


def detect_windows_gpus() -> list[GPUInfo]:
    output = run_command([
        "powershell",
        "-NoProfile",
        "-Command",
        """
        Get-CimInstance Win32_VideoController |
        Select-Object Name,AdapterRAM |
        ConvertTo-Json
        """,
    ])

    if not output:
        return []

    try:
        parsed = json.loads(output)

        if isinstance(parsed, dict):
            parsed = [parsed]

        result = []

        for gpu in parsed:
            name = gpu.get("Name") or "Unknown GPU"
            ram = gpu.get("AdapterRAM")

            vram_mb = None

            if isinstance(ram, int):
                vram_mb = int(ram / (1024 ** 2))

            result.append(
                GPUInfo(
                    name=name,
                    vendor=gpu_vendor(name),
                    vram_mb=vram_mb,
                    directml_possible=True,
                )
            )

        return result

    except Exception:
        return []


def detect_macos_gpu() -> list[GPUInfo]:
    output = run_command([
        "system_profiler",
        "SPDisplaysDataType",
    ])

    if not output:
        return []

    result = []

    for line in output.splitlines():
        line = line.strip()

        if line.startswith("Chipset Model:"):
            name = line.split(":", 1)[1].strip()

            result.append(
                GPUInfo(
                    name=name,
                    vendor=gpu_vendor(name),
                    metal_possible=True,
                )
            )

    return result


def detect_linux_gpus() -> list[GPUInfo]:
    output = run_command([
        "lspci",
    ])

    result = []

    for line in output.splitlines():
        lower = line.lower()

        if "vga compatible controller" not in lower \
                and "3d controller" not in lower:
            continue

        name = line.split(":", 2)[-1].strip()

        result.append(
            GPUInfo(
                name=name,
                vendor=gpu_vendor(name),
            )
        )

    return result


def detect_vulkan_support() -> bool:
    if shutil.which("vulkaninfo") is None:
        return False

    output = run_command([
        "vulkaninfo",
        "--summary",
    ])

    return bool(output)


def detect_gpus() -> list[GPUInfo]:
    system = platform.system()

    gpus: list[GPUInfo] = []

    # Prefer NVIDIA SMI because VRAM reporting is useful.
    gpus.extend(detect_nvidia_gpus())

    existing_names = {
        gpu.name.lower()
        for gpu in gpus
    }

    if system == "Windows":
        platform_gpus = detect_windows_gpus()

    elif system == "Darwin":
        platform_gpus = detect_macos_gpu()

    elif system == "Linux":
        platform_gpus = detect_linux_gpus()

    else:
        platform_gpus = []

    for gpu in platform_gpus:
        if gpu.name.lower() not in existing_names:
            gpus.append(gpu)

    vulkan = detect_vulkan_support()

    for gpu in gpus:
        if vulkan:
            gpu.vulkan = True

        if system == "Windows":
            gpu.directml_possible = True

        if system == "Darwin":
            gpu.metal_possible = True

    return gpus


def detect_ffmpeg_capabilities() -> CodecCapabilities:
    caps = CodecCapabilities()

    if shutil.which("ffmpeg") is None:
        return caps

    caps.ffmpeg_available = True

    decoders = run_command([
        "ffmpeg",
        "-hide_banner",
        "-decoders",
    ]).lower()

    encoders = run_command([
        "ffmpeg",
        "-hide_banner",
        "-encoders",
    ]).lower()

    hwaccels = run_command([
        "ffmpeg",
        "-hide_banner",
        "-hwaccels",
    ]).lower()

    caps.h264_decode = " h264 " in decoders
    caps.hevc_decode = " hevc " in decoders
    caps.av1_decode = " av1 " in decoders

    caps.h264_encode = "libx264" in encoders
    caps.hevc_encode = "libx265" in encoders
    caps.av1_encode = (
        "libaom-av1" in encoders
        or "svt-av1" in encoders
    )

    caps.nvenc = "_nvenc" in encoders
    caps.qsv = "_qsv" in encoders or "qsv" in hwaccels
    caps.vaapi = "_vaapi" in encoders or "vaapi" in hwaccels
    caps.videotoolbox = (
        "_videotoolbox" in encoders
        or "videotoolbox" in hwaccels
    )
    caps.amf = "_amf" in encoders

    return caps


def classify_hardware(
    cpu: CPUInfo,
    memory: MemoryInfo,
    gpus: list[GPUInfo],
) -> tuple[str, list[str]]:
    score = 0
    notes = []

    logical = cpu.logical_cores or 0

    if logical >= 16:
        score += 3
    elif logical >= 8:
        score += 2
    elif logical >= 4:
        score += 1

    if memory.total_gb >= 32:
        score += 3
    elif memory.total_gb >= 16:
        score += 2
    elif memory.total_gb >= 8:
        score += 1

    best_vram = max(
        (
            gpu.vram_mb or 0
            for gpu in gpus
        ),
        default=0,
    )

    has_discrete = any(
        gpu.vendor in {"NVIDIA", "AMD"}
        for gpu in gpus
    )

    if best_vram >= 8000:
        score += 4

    elif best_vram >= 4000:
        score += 3

    elif has_discrete:
        score += 2

    elif gpus:
        score += 1

    if memory.total_gb < 8:
        notes.append(
            "Low system memory: prefer proxies and lightweight models."
        )

    if not has_discrete:
        notes.append(
            "No obvious discrete GPU: favor CPU/iGPU-friendly inference."
        )

    if best_vram and best_vram < 4000:
        notes.append(
            "Limited VRAM: avoid large GPU-resident models."
        )

    if score <= 3:
        tier = "low"

    elif score <= 6:
        tier = "mainstream"

    elif score <= 9:
        tier = "high"

    else:
        tier = "enthusiast"

    return tier, notes


def build_profile() -> HardwareProfile:
    cpu = detect_cpu()
    memory = detect_memory()
    disks = detect_disks()
    gpus = detect_gpus()
    codecs = detect_ffmpeg_capabilities()

    tier, notes = classify_hardware(
        cpu,
        memory,
        gpus,
    )

    return HardwareProfile(
        os=platform.system(),
        os_version=platform.platform(),
        cpu=cpu,
        memory=memory,
        disks=disks,
        gpus=gpus,
        codecs=codecs,
        suggested_tier=tier,
        notes=notes,
    )


def main() -> None:
    profile = build_profile()

    print(
        json.dumps(
            asdict(profile),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()