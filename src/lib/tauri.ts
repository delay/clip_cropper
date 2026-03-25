import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'

import type {
  BatchExportPayload,
  BatchExportResult,
  ExportPayload,
  ExportResult,
  VideoSource,
} from './types'

type DesktopProbe = {
  path: string
  name: string
  width: number
  height: number
  duration: number
  fps: number
  hasAudio: boolean
}

export function isDesktopRuntime() {
  return isTauri()
}

export async function pickVideoFromDesktop(): Promise<VideoSource | null> {
  const file = await invoke<DesktopProbe | null>('pick_video')

  if (!file) {
    return null
  }

  return {
    ...file,
    sourceUrl: convertFileSrc(file.path),
  }
}

export async function exportVideoFromDesktop(
  payload: ExportPayload,
): Promise<ExportResult | null> {
  return invoke<ExportResult | null>('export_video', { request: payload })
}

export async function exportVideoBatchFromDesktop(
  payload: BatchExportPayload,
): Promise<BatchExportResult | null> {
  return invoke<BatchExportResult | null>('export_video_batch', { request: payload })
}
