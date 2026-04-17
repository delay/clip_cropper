use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::TempDir;
use tauri::Emitter;

const SIMULATOR_EXTEND_WIDTH: u32 = 5760;
const SIMULATOR_EXTEND_HEIGHT: u32 = 1080;
const SIMULATOR_CENTER_WIDTH: u32 = 1920;
const SIMULATOR_CENTER_HEIGHT: u32 = 1080;
const SIMULATOR_EDGE_SAMPLE_WIDTH: u32 = 308;
const SIMULATOR_SIDE_WIDTH: u32 = (SIMULATOR_EXTEND_WIDTH - SIMULATOR_CENTER_WIDTH) / 2;
const EXPORT_PROGRESS_EVENT: &str = "export-progress";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoProbe {
    path: String,
    name: String,
    width: u32,
    height: u32,
    duration: f64,
    fps: f64,
    has_audio: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CropRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrimRange {
    start: f64,
    end: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlipState {
    horizontal: bool,
    vertical: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaleSize {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum UpscaleQuality {
    Standard,
    High,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    input_path: String,
    suggested_filename: String,
    crop: CropRect,
    trim: TrimRange,
    flip: FlipState,
    scale: ScaleSize,
    upscale_quality: UpscaleQuality,
    simulator_extend: bool,
    include_audio: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchClip {
    name: String,
    crop: CropRect,
    trim: TrimRange,
    flip: FlipState,
    scale: ScaleSize,
    upscale_quality: UpscaleQuality,
    simulator_extend: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchExportRequest {
    input_path: String,
    base_filename: String,
    export_mode: String,
    include_audio: bool,
    clips: Vec<BatchClip>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    output_path: String,
    ffmpeg_args: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchExportResult {
    output_paths: Vec<String>,
    ffmpeg_commands: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    current_step: usize,
    total_steps: usize,
    step_label: String,
    step_progress: f64,
    overall_progress: f64,
}

#[derive(Debug, Clone)]
struct ProgressPlan {
    current_step: usize,
    total_steps: usize,
    step_label: String,
    overall_start: f64,
    overall_span: f64,
    duration_seconds: f64,
}

#[tauri::command]
fn pick_video() -> Result<Option<VideoProbe>, String> {
    let file = FileDialog::new()
        .add_filter("Video", &["mp4", "mov", "m4v", "mkv", "webm"])
        .pick_file();

    match file {
        Some(path) => probe_video(path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn export_video(window: tauri::Window, request: ExportRequest) -> Result<Option<ExportResult>, String> {
    let output_path = FileDialog::new()
        .set_file_name(&request.suggested_filename)
        .add_filter("MP4", &["mp4"])
        .save_file();

    let Some(output_path) = output_path else {
        return Ok(None);
    };

    let mut emit_progress = |progress: ExportProgress| {
        let _ = window.emit(EXPORT_PROGRESS_EVENT, &progress);
    };

    export_single_to_path_with_progress(&request, &output_path, &mut emit_progress).map(Some)
}

#[tauri::command]
fn export_video_batch(
    window: tauri::Window,
    request: BatchExportRequest,
) -> Result<Option<BatchExportResult>, String> {
    if request.clips.is_empty() {
        return Err("No saved selections to export.".to_string());
    }

    let mut emit_progress = |progress: ExportProgress| {
        let _ = window.emit(EXPORT_PROGRESS_EVENT, &progress);
    };

    match request.export_mode.as_str() {
        "individual" => export_individual_batch_with_progress(request, &mut emit_progress).map(Some),
        "continuous" => export_continuous_batch_with_progress(request, &mut emit_progress).map(Some),
        other => Err(format!("Unsupported export mode: {other}")),
    }
}

fn export_individual_batch_with_progress<F>(
    request: BatchExportRequest,
    on_progress: &mut F,
) -> Result<BatchExportResult, String>
where
    F: FnMut(ExportProgress),
{
    let output_folder = FileDialog::new().pick_folder();
    let Some(output_folder) = output_folder else {
        return Err("Export cancelled.".to_string());
    };

    export_individual_batch_to_folder_with_progress(&request, &output_folder, on_progress)
}

fn export_continuous_batch_with_progress<F>(
    request: BatchExportRequest,
    on_progress: &mut F,
) -> Result<BatchExportResult, String>
where
    F: FnMut(ExportProgress),
{
    let output_path = FileDialog::new()
        .set_file_name(&format!("{}-sequence.mp4", sanitize_filename(&request.base_filename)))
        .add_filter("MP4", &["mp4"])
        .save_file();

    let Some(output_path) = output_path else {
        return Err("Export cancelled.".to_string());
    };

    export_continuous_batch_to_path_with_progress(&request, &output_path, on_progress)
}

#[cfg_attr(not(test), allow(dead_code))]
fn export_single_to_path(request: &ExportRequest, output_path: &Path) -> Result<ExportResult, String> {
    let mut ignore_progress = |_| {};
    export_single_to_path_with_progress(request, output_path, &mut ignore_progress)
}

fn export_single_to_path_with_progress<F>(
    request: &ExportRequest,
    output_path: &Path,
    on_progress: &mut F,
) -> Result<ExportResult, String>
where
    F: FnMut(ExportProgress),
{
    let clip = BatchClip {
        name: request.suggested_filename.clone(),
        crop: request.crop.clone(),
        trim: request.trim.clone(),
        flip: request.flip.clone(),
        scale: request.scale.clone(),
        upscale_quality: request.upscale_quality.clone(),
        simulator_extend: request.simulator_extend,
    };

    validate_clip(&clip)?;
    let args = build_clip_args(&request.input_path, &clip, request.include_audio, output_path);
    let progress = ProgressPlan {
        current_step: 1,
        total_steps: 1,
        step_label: "Encoding export".to_string(),
        overall_start: 0.0,
        overall_span: 1.0,
        duration_seconds: clip_duration(&clip),
    };
    run_ffmpeg_with_progress(&args, &progress, on_progress)?;

    Ok(ExportResult {
        output_path: output_path.display().to_string(),
        ffmpeg_args: args,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
fn export_individual_batch_to_folder(
    request: &BatchExportRequest,
    output_folder: &Path,
) -> Result<BatchExportResult, String> {
    let mut ignore_progress = |_| {};
    export_individual_batch_to_folder_with_progress(request, output_folder, &mut ignore_progress)
}

fn export_individual_batch_to_folder_with_progress<F>(
    request: &BatchExportRequest,
    output_folder: &Path,
    on_progress: &mut F,
) -> Result<BatchExportResult, String>
where
    F: FnMut(ExportProgress),
{
    let base_name = sanitize_filename(&request.base_filename);
    let mut output_paths = Vec::with_capacity(request.clips.len());
    let mut ffmpeg_commands = Vec::with_capacity(request.clips.len());
    let total_duration = request
        .clips
        .iter()
        .map(clip_duration)
        .sum::<f64>()
        .max(0.001);
    let total_steps = request.clips.len();
    let mut completed_share = 0.0;

    for (index, clip) in request.clips.iter().enumerate() {
        validate_clip(clip)?;
        let clip_name = sanitize_filename(&clip.name);
        let filename = format!("{base_name}-{:02}-{clip_name}.mp4", index + 1);
        let output_path = output_folder.join(filename);
        let args = build_clip_args(&request.input_path, clip, request.include_audio, &output_path);
        let clip_share = clip_duration(clip) / total_duration;
        let progress = ProgressPlan {
            current_step: index + 1,
            total_steps,
            step_label: format!("Encoding clip {} of {}", index + 1, total_steps),
            overall_start: completed_share,
            overall_span: clip_share,
            duration_seconds: clip_duration(clip),
        };
        run_ffmpeg_with_progress(&args, &progress, on_progress)?;
        completed_share += clip_share;
        output_paths.push(output_path.display().to_string());
        ffmpeg_commands.push(args);
    }

    Ok(BatchExportResult {
        output_paths,
        ffmpeg_commands,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
fn export_continuous_batch_to_path(
    request: &BatchExportRequest,
    output_path: &Path,
) -> Result<BatchExportResult, String> {
    let mut ignore_progress = |_| {};
    export_continuous_batch_to_path_with_progress(request, output_path, &mut ignore_progress)
}

fn export_continuous_batch_to_path_with_progress<F>(
    request: &BatchExportRequest,
    output_path: &Path,
    on_progress: &mut F,
) -> Result<BatchExportResult, String>
where
    F: FnMut(ExportProgress),
{
    let Some(first_clip) = request.clips.first() else {
        return Err("No saved selections to export.".to_string());
    };

    validate_clip(first_clip)?;

    for clip in &request.clips {
        validate_clip(clip)?;
        if clip.scale.width != first_clip.scale.width || clip.scale.height != first_clip.scale.height {
            return Err(
                "Continuous export requires every saved selection to use the same output size."
                    .to_string(),
            );
        }
    }

    let temp_dir = TempDir::new().map_err(|error| format!("Failed to create temp folder: {error}"))?;
    let mut ffmpeg_commands = Vec::with_capacity(request.clips.len() + 1);
    let mut segment_paths = Vec::with_capacity(request.clips.len());
    let segment_duration = request
        .clips
        .iter()
        .map(clip_duration)
        .sum::<f64>()
        .max(0.001);
    let total_work = (segment_duration * 2.0).max(0.001);
    let total_steps = request.clips.len() + 1;
    let mut completed_share = 0.0;

    for (index, clip) in request.clips.iter().enumerate() {
        let segment_path = temp_dir.path().join(format!("segment-{index:02}.mp4"));
        let args = build_clip_args(&request.input_path, clip, request.include_audio, &segment_path);
        let clip_share = clip_duration(clip) / total_work;
        let progress = ProgressPlan {
            current_step: index + 1,
            total_steps,
            step_label: format!("Encoding segment {} of {}", index + 1, request.clips.len()),
            overall_start: completed_share,
            overall_span: clip_share,
            duration_seconds: clip_duration(clip),
        };
        run_ffmpeg_with_progress(&args, &progress, on_progress)?;
        completed_share += clip_share;
        ffmpeg_commands.push(args);
        segment_paths.push(segment_path);
    }

    let concat_file = write_concat_manifest(temp_dir.path(), &segment_paths)?;
    let concat_args = vec![
        "-y".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        concat_file.display().to_string(),
        "-c".to_string(),
        "copy".to_string(),
        output_path.display().to_string(),
    ];
    let concat_progress = ProgressPlan {
        current_step: total_steps,
        total_steps,
        step_label: "Combining segments".to_string(),
        overall_start: completed_share,
        overall_span: segment_duration / total_work,
        duration_seconds: segment_duration,
    };
    run_ffmpeg_with_progress(&concat_args, &concat_progress, on_progress)?;
    ffmpeg_commands.push(concat_args);

    Ok(BatchExportResult {
        output_paths: vec![output_path.display().to_string()],
        ffmpeg_commands,
    })
}

fn validate_clip(clip: &BatchClip) -> Result<(), String> {
    if clip.crop.width == 0 || clip.crop.height == 0 {
        return Err("Crop area must be larger than zero.".to_string());
    }

    if clip.scale.width == 0 || clip.scale.height == 0 {
        return Err("Export size must be larger than zero.".to_string());
    }

    if clip.simulator_extend
        && (clip.scale.width != SIMULATOR_EXTEND_WIDTH || clip.scale.height != SIMULATOR_EXTEND_HEIGHT)
    {
        return Err("Simulator extend export must output at 5760 × 1080.".to_string());
    }

    if clip.trim.end <= clip.trim.start {
        return Err("Trim out point must be after the in point.".to_string());
    }

    Ok(())
}

fn write_concat_manifest(temp_dir: &Path, segment_paths: &[PathBuf]) -> Result<PathBuf, String> {
    let manifest_path = temp_dir.join("concat.txt");
    let contents = segment_paths
        .iter()
        .map(|path| format!("file '{}'\n", escape_concat_path(path)))
        .collect::<String>();

    fs::write(&manifest_path, contents)
        .map_err(|error| format!("Failed to write concat manifest: {error}"))?;

    Ok(manifest_path)
}

fn escape_concat_path(path: &Path) -> String {
    path.display().to_string().replace('\'', "'\\''")
}

fn run_ffmpeg_with_progress<F>(
    args: &[String],
    progress_plan: &ProgressPlan,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(ExportProgress),
{
    emit_progress(on_progress, progress_plan, 0.0);

    let mut child = Command::new("ffmpeg")
        .args(["-progress", "pipe:1", "-nostats"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to run ffmpeg: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture ffmpeg progress output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture ffmpeg error output.".to_string())?;

    let stderr_reader = thread::spawn(move || -> Result<String, String> {
        let mut stderr_output = String::new();
        BufReader::new(stderr)
            .read_to_string(&mut stderr_output)
            .map_err(|error| format!("Failed to read ffmpeg error output: {error}"))?;
        Ok(stderr_output)
    });

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Failed to read ffmpeg progress output: {error}"))?;

        if let Some(raw_time) = line.strip_prefix("out_time=") {
            if let Some(seconds) = parse_ffmpeg_timecode(raw_time) {
                let step_progress = if progress_plan.duration_seconds <= 0.0 {
                    0.0
                } else {
                    seconds / progress_plan.duration_seconds
                };
                emit_progress(on_progress, progress_plan, step_progress);
            }
            continue;
        }

        if line == "progress=end" {
            emit_progress(on_progress, progress_plan, 1.0);
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait for ffmpeg: {error}"))?;
    let stderr_output = stderr_reader
        .join()
        .map_err(|_| "Failed to join ffmpeg error reader.".to_string())??;

    if !status.success() {
        let stderr = stderr_output.trim();
        return Err(if stderr.is_empty() {
            format!("ffmpeg exited with status {status}")
        } else {
            stderr.to_string()
        });
    }

    emit_progress(on_progress, progress_plan, 1.0);
    Ok(())
}

fn emit_progress<F>(on_progress: &mut F, plan: &ProgressPlan, step_progress: f64)
where
    F: FnMut(ExportProgress),
{
    let step_progress = step_progress.clamp(0.0, 1.0);
    on_progress(ExportProgress {
        current_step: plan.current_step,
        total_steps: plan.total_steps,
        step_label: plan.step_label.clone(),
        step_progress,
        overall_progress: (plan.overall_start + (plan.overall_span * step_progress)).clamp(0.0, 1.0),
    });
}

fn clip_duration(clip: &BatchClip) -> f64 {
    (clip.trim.end - clip.trim.start).max(0.001)
}

fn parse_ffmpeg_timecode(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;

    if parts.next().is_some() {
        return None;
    }

    Some((hours * 3600.0) + (minutes * 60.0) + seconds)
}

#[cfg(test)]
fn sample_video_pixel(path: &Path, x: u32, y: u32) -> Result<[u8; 3], String> {
    let filter = format!("crop=1:1:{x}:{y},format=rgb24");
    let output = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-ss",
            "0.5",
            "-i",
            &path.display().to_string(),
            "-vf",
            &filter,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .map_err(|error| format!("Failed to sample video pixel: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }

    if output.stdout.len() < 3 {
        return Err("Failed to read sampled pixel.".to_string());
    }

    Ok([output.stdout[0], output.stdout[1], output.stdout[2]])
}

fn build_clip_args(
    input_path: &str,
    clip: &BatchClip,
    include_audio: bool,
    output_path: &Path,
) -> Vec<String> {
    let trim_duration = (clip.trim.end - clip.trim.start).max(0.001);
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input_path.to_string(),
        "-ss".to_string(),
        format_time_arg(clip.trim.start),
        "-t".to_string(),
        format_time_arg(trim_duration),
    ];

    if clip.simulator_extend {
        args.extend([
            "-filter_complex".to_string(),
            build_simulator_filter_chain(clip),
            "-map".to_string(),
            "[vout]".to_string(),
        ]);

        if include_audio {
            args.extend(["-map".to_string(), "0:a?".to_string()]);
        } else {
            args.push("-an".to_string());
        }
    } else {
        args.extend(["-vf".to_string(), build_filter_chain(clip)]);

        if !include_audio {
            args.push("-an".to_string());
        }
    }

    args.extend([
        "-c:v".to_string(),
        "libx264".to_string(),
        "-crf".to_string(),
        "18".to_string(),
        "-preset".to_string(),
        "medium".to_string(),
    ]);

    if include_audio {
        args.extend([
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
        ]);
    }

    args.extend([
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.display().to_string(),
    ]);

    args
}

fn probe_video(path: PathBuf) -> Result<VideoProbe, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            &path.display().to_string(),
        ])
        .output()
        .map_err(|error| format!("Failed to run ffprobe: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }

    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to parse ffprobe output: {error}"))?;

    let streams = parsed["streams"]
        .as_array()
        .ok_or_else(|| "ffprobe returned no streams".to_string())?;
    let video_stream = streams
        .iter()
        .find(|stream| stream["codec_type"].as_str() == Some("video"))
        .ok_or_else(|| "No video stream found".to_string())?;

    let width = video_stream["width"]
        .as_u64()
        .ok_or_else(|| "Missing video width".to_string())? as u32;
    let height = video_stream["height"]
        .as_u64()
        .ok_or_else(|| "Missing video height".to_string())? as u32;

    let duration = video_stream["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| {
            parsed["format"]["duration"]
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
        })
        .unwrap_or_default();

    let fps = video_stream["avg_frame_rate"]
        .as_str()
        .and_then(parse_fraction)
        .or_else(|| video_stream["r_frame_rate"].as_str().and_then(parse_fraction))
        .unwrap_or(30.0);

    let has_audio = streams
        .iter()
        .any(|stream| stream["codec_type"].as_str() == Some("audio"));

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("video.mp4")
        .to_string();

    Ok(VideoProbe {
        path: path.display().to_string(),
        name,
        width,
        height,
        duration,
        fps,
        has_audio,
    })
}

fn parse_fraction(value: &str) -> Option<f64> {
    let mut parts = value.split('/');
    let numerator = parts.next()?.parse::<f64>().ok()?;
    let denominator = parts.next()?.parse::<f64>().ok()?;

    if denominator == 0.0 {
        return None;
    }

    Some(numerator / denominator)
}

fn build_filter_chain(clip: &BatchClip) -> String {
    let mut filters = vec![format!(
        "crop={}:{}:{}:{}",
        clip.crop.width, clip.crop.height, clip.crop.x, clip.crop.y
    )];

    if clip.flip.horizontal {
        filters.push("hflip".to_string());
    }

    if clip.flip.vertical {
        filters.push("vflip".to_string());
    }

    if clip.scale.width != clip.crop.width || clip.scale.height != clip.crop.height {
        if clip.upscale_quality == UpscaleQuality::High {
            filters.push(format!(
                "scale={}:{}:flags=lanczos",
                clip.scale.width, clip.scale.height
            ));
            filters.push("unsharp=5:5:0.6:5:5:0.0".to_string());
        } else {
            filters.push(format!("scale={}:{}", clip.scale.width, clip.scale.height));
        }
    }

    filters.push("setsar=1".to_string());

    filters.join(",")
}

fn build_simulator_filter_chain(clip: &BatchClip) -> String {
    let mut scaled_filters = vec![format!(
        "crop={}:{}:{}:{}",
        clip.crop.width, clip.crop.height, clip.crop.x, clip.crop.y
    )];

    if clip.flip.horizontal {
        scaled_filters.push("hflip".to_string());
    }

    if clip.flip.vertical {
        scaled_filters.push("vflip".to_string());
    }

    scaled_filters.push(format!(
        "scale={}:{}:flags=lanczos",
        SIMULATOR_CENTER_WIDTH, SIMULATOR_CENTER_HEIGHT
    ));

    [
        format!(
            "[0:v]{},split=3[center][leftsrc][rightsrc]",
            scaled_filters.join(",")
        ),
        format!(
            "[leftsrc]crop='if(gte(iw,{0}),{0},iw)':ih:0:0,scale={1}:{2}:flags=lanczos,gblur=sigma=55,eq=brightness=-0.07[left]",
            SIMULATOR_EDGE_SAMPLE_WIDTH,
            SIMULATOR_SIDE_WIDTH,
            SIMULATOR_EXTEND_HEIGHT
        ),
        format!(
            "[rightsrc]crop='if(gte(iw,{0}),{0},iw)':ih:'if(gte(iw,{0}),iw-{0},0)':0,scale={1}:{2}:flags=lanczos,gblur=sigma=55,eq=brightness=-0.07[right]",
            SIMULATOR_EDGE_SAMPLE_WIDTH,
            SIMULATOR_SIDE_WIDTH,
            SIMULATOR_EXTEND_HEIGHT
        ),
        "[left][center][right]hstack=inputs=3,setsar=1[vout]".to_string(),
    ]
    .join(";")
}

fn format_time_arg(value: f64) -> String {
    format!("{:.3}", value.max(0.0))
}

fn sanitize_filename(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
            _ => '-',
        })
        .collect::<String>();

    cleaned.trim_matches('-').to_string().if_empty("clip")
}

trait DefaultIfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl DefaultIfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_fixture_video(temp_dir: &Path) -> PathBuf {
        let input_path = temp_dir.join("fixture.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:sample_rate=48000",
                "-t",
                "4",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                input_path.to_str().expect("fixture path should be valid utf-8"),
            ])
            .status()
            .expect("ffmpeg should launch");

        assert!(status.success(), "fixture generation failed");
        input_path
    }

    #[test]
    fn exports_single_clip_to_expected_size() {
        let temp_dir = tempdir().expect("temp dir");
        let input_path = create_fixture_video(temp_dir.path());
        let output_path = temp_dir.path().join("single.mp4");

        let request = ExportRequest {
            input_path: input_path.display().to_string(),
            suggested_filename: "single.mp4".to_string(),
            crop: CropRect {
                x: 80,
                y: 40,
                width: 320,
                height: 180,
            },
            trim: TrimRange {
                start: 0.5,
                end: 2.0,
            },
            flip: FlipState {
                horizontal: false,
                vertical: false,
            },
            scale: ScaleSize {
                width: 320,
                height: 180,
            },
            upscale_quality: UpscaleQuality::Standard,
            simulator_extend: false,
            include_audio: true,
        };

        let result = export_single_to_path(&request, &output_path).expect("single export");
        let probe = probe_video(output_path.clone()).expect("probe exported video");

        assert_eq!(result.output_path, output_path.display().to_string());
        assert_eq!(probe.width, 320);
        assert_eq!(probe.height, 180);
        assert!(probe.has_audio);
        assert!(
            (probe.duration - 1.5).abs() < 0.2,
            "expected duration near 1.5s, got {}",
            probe.duration
        );
    }

    #[test]
    fn exports_individual_batch_clips() {
        let temp_dir = tempdir().expect("temp dir");
        let input_path = create_fixture_video(temp_dir.path());
        let output_folder = temp_dir.path().join("individual");
        fs::create_dir(&output_folder).expect("create output folder");

        let request = BatchExportRequest {
            input_path: input_path.display().to_string(),
            base_filename: "bundle".to_string(),
            export_mode: "individual".to_string(),
            include_audio: false,
            clips: vec![
                BatchClip {
                    name: "first".to_string(),
                    crop: CropRect {
                        x: 0,
                        y: 0,
                        width: 320,
                        height: 180,
                    },
                    trim: TrimRange {
                        start: 0.0,
                        end: 1.0,
                    },
                    flip: FlipState {
                        horizontal: false,
                        vertical: false,
                    },
                    scale: ScaleSize {
                        width: 320,
                        height: 180,
                    },
                    upscale_quality: UpscaleQuality::Standard,
                    simulator_extend: false,
                },
                BatchClip {
                    name: "second".to_string(),
                    crop: CropRect {
                        x: 160,
                        y: 90,
                        width: 320,
                        height: 180,
                    },
                    trim: TrimRange {
                        start: 1.5,
                        end: 2.5,
                    },
                    flip: FlipState {
                        horizontal: true,
                        vertical: false,
                    },
                    scale: ScaleSize {
                        width: 320,
                        height: 180,
                    },
                    upscale_quality: UpscaleQuality::Standard,
                    simulator_extend: false,
                },
            ],
        };

        let result =
            export_individual_batch_to_folder(&request, &output_folder).expect("individual batch");

        assert_eq!(result.output_paths.len(), 2);
        for output_path in &result.output_paths {
            let probe = probe_video(PathBuf::from(output_path)).expect("probe individual export");
            assert_eq!(probe.width, 320);
            assert_eq!(probe.height, 180);
            assert!(!probe.has_audio);
        }
    }

    #[test]
    fn exports_continuous_batch_clip() {
        let temp_dir = tempdir().expect("temp dir");
        let input_path = create_fixture_video(temp_dir.path());
        let output_path = temp_dir.path().join("sequence.mp4");

        let request = BatchExportRequest {
            input_path: input_path.display().to_string(),
            base_filename: "sequence".to_string(),
            export_mode: "continuous".to_string(),
            include_audio: true,
            clips: vec![
                BatchClip {
                    name: "first".to_string(),
                    crop: CropRect {
                        x: 0,
                        y: 0,
                        width: 320,
                        height: 180,
                    },
                    trim: TrimRange {
                        start: 0.0,
                        end: 1.0,
                    },
                    flip: FlipState {
                        horizontal: false,
                        vertical: false,
                    },
                    scale: ScaleSize {
                        width: 320,
                        height: 180,
                    },
                    upscale_quality: UpscaleQuality::Standard,
                    simulator_extend: false,
                },
                BatchClip {
                    name: "second".to_string(),
                    crop: CropRect {
                        x: 160,
                        y: 90,
                        width: 320,
                        height: 180,
                    },
                    trim: TrimRange {
                        start: 2.0,
                        end: 3.0,
                    },
                    flip: FlipState {
                        horizontal: false,
                        vertical: true,
                    },
                    scale: ScaleSize {
                        width: 320,
                        height: 180,
                    },
                    upscale_quality: UpscaleQuality::Standard,
                    simulator_extend: false,
                },
            ],
        };

        let result =
            export_continuous_batch_to_path(&request, &output_path).expect("continuous batch");
        let probe = probe_video(output_path.clone()).expect("probe continuous export");

        assert_eq!(result.output_paths, vec![output_path.display().to_string()]);
        assert_eq!(probe.width, 320);
        assert_eq!(probe.height, 180);
        assert!(probe.has_audio);
        assert!(
            (probe.duration - 2.0).abs() < 0.25,
            "expected duration near 2.0s, got {}",
            probe.duration
        );
    }

    #[test]
    fn exports_simulator_extend_clip() {
        let temp_dir = tempdir().expect("temp dir");
        let input_path = create_fixture_video(temp_dir.path());
        let output_path = temp_dir.path().join("simulator.mp4");

        let request = ExportRequest {
            input_path: input_path.display().to_string(),
            suggested_filename: "simulator.mp4".to_string(),
            crop: CropRect {
                x: 0,
                y: 0,
                width: 640,
                height: 360,
            },
            trim: TrimRange {
                start: 0.25,
                end: 1.75,
            },
            flip: FlipState {
                horizontal: false,
                vertical: false,
            },
            scale: ScaleSize {
                width: SIMULATOR_EXTEND_WIDTH,
                height: SIMULATOR_EXTEND_HEIGHT,
            },
            upscale_quality: UpscaleQuality::High,
            simulator_extend: true,
            include_audio: true,
        };

        let result = export_single_to_path(&request, &output_path).expect("simulator export");
        let probe = probe_video(output_path.clone()).expect("probe simulator export");

        assert_eq!(result.output_path, output_path.display().to_string());
        assert_eq!(probe.width, SIMULATOR_EXTEND_WIDTH);
        assert_eq!(probe.height, SIMULATOR_EXTEND_HEIGHT);
        assert!(probe.has_audio);
        let left_pixel =
            sample_video_pixel(&output_path, 10, SIMULATOR_EXTEND_HEIGHT / 2).expect("sample left edge");
        let right_pixel = sample_video_pixel(
            &output_path,
            SIMULATOR_EXTEND_WIDTH - 10,
            SIMULATOR_EXTEND_HEIGHT / 2,
        )
        .expect("sample right edge");
        assert_ne!(left_pixel, [0, 0, 0], "left side fill should not be black");
        assert_ne!(right_pixel, [0, 0, 0], "right side fill should not be black");
        assert!(
            (probe.duration - 1.5).abs() < 0.25,
            "expected duration near 1.5s, got {}",
            probe.duration
        );
    }

    #[test]
    fn high_quality_upscale_uses_lanczos_and_unsharp() {
        let clip = BatchClip {
            name: "hq".to_string(),
            crop: CropRect {
                x: 0,
                y: 0,
                width: 320,
                height: 180,
            },
            trim: TrimRange {
                start: 0.0,
                end: 1.0,
            },
            flip: FlipState {
                horizontal: false,
                vertical: false,
            },
            scale: ScaleSize {
                width: 1920,
                height: 1080,
            },
            upscale_quality: UpscaleQuality::High,
            simulator_extend: false,
        };

        let filter = build_filter_chain(&clip);

        assert!(filter.contains("scale=1920:1080:flags=lanczos"));
        assert!(filter.contains("unsharp=5:5:0.6:5:5:0.0"));
    }

    #[test]
    fn simulator_extend_uses_single_stretched_fill_per_side() {
        let clip = BatchClip {
            name: "simulator".to_string(),
            crop: CropRect {
                x: 0,
                y: 0,
                width: 640,
                height: 360,
            },
            trim: TrimRange {
                start: 0.0,
                end: 1.0,
            },
            flip: FlipState {
                horizontal: false,
                vertical: false,
            },
            scale: ScaleSize {
                width: SIMULATOR_EXTEND_WIDTH,
                height: SIMULATOR_EXTEND_HEIGHT,
            },
            upscale_quality: UpscaleQuality::High,
            simulator_extend: true,
        };

        let filter = build_simulator_filter_chain(&clip);

        assert!(filter.contains("split=3[center][leftsrc][rightsrc]"));
        assert!(filter.contains("scale=1920:1080:flags=lanczos"));
        assert!(filter.contains("[left][center][right]hstack=inputs=3,setsar=1[vout]"));
        assert!(!filter.contains("pad=1920:1080"));
        assert!(!filter.contains("overlay="));
        assert!(!filter.contains("nearlsrc"));
        assert!(!filter.contains("farlsrc"));
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_video,
            export_video,
            export_video_batch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
