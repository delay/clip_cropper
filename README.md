# Clip Cropper

Single-clip crop-and-trim desktop app built with React, Tauri, `ffprobe`, and `ffmpeg`.

## What it does

- Open one video file
- Preview and reposition a crop rectangle on top of the clip
- Lock the crop to `1:1`, `3:1`, `5:1`, `6:1`, or a custom ratio
- Set one In point and one Out point
- Flip horizontally or vertically
- Export the trimmed and cropped result to MP4

## Run it

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install Rust if it is not already on the machine:

   ```bash
   curl https://sh.rustup.rs -sSf | sh
   ```

3. Start the desktop app:

   ```bash
   npm run tauri dev
   ```

For browser-only preview while the Rust toolchain is missing:

```bash
npm run dev
```

That mode supports loading a local clip and using the crop/trim UI, but export stays disabled because `ffprobe` and `ffmpeg` are called from the Tauri backend.
