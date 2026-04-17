export type AspectPresetId = 'source' | 'widescreen' | 'ultrawide' | 'square' | 'triple'

export type CropRect = {
  x: number
  y: number
  width: number
  height: number
}

export type TrimRange = {
  start: number
  end: number
}

export type FlipState = {
  horizontal: boolean
  vertical: boolean
}

export type OutputSize = {
  width: number
  height: number
}

export type UpscaleQuality = 'standard' | 'high'

export type VideoSource = {
  path?: string
  name: string
  sourceUrl: string
  width: number
  height: number
  duration: number
  fps: number
  hasAudio: boolean
}

export type ExportPayload = {
  inputPath: string
  suggestedFilename: string
  crop: CropRect
  trim: TrimRange
  flip: FlipState
  scale: OutputSize
  upscaleQuality: UpscaleQuality
  simulatorExtend: boolean
  includeAudio: boolean
}

export type ExportResult = {
  outputPath: string
  ffmpegArgs: string[]
}

export type ExportProgress = {
  currentStep: number
  totalSteps: number
  stepLabel: string
  stepProgress: number
  overallProgress: number
}

export type SavedSelection = {
  id: string
  name: string
  crop: CropRect
  trim: TrimRange
  flip: FlipState
  aspectPreset: AspectPresetId
  scaleMode: 'crop' | 'preset'
  upscaleQuality: UpscaleQuality
  simulatorExtend: boolean
  thumbnailUrl: string
}

export type BatchExportPayload = {
  inputPath: string
  baseFilename: string
  exportMode: 'continuous' | 'individual'
  includeAudio: boolean
  clips: Array<{
    name: string
    crop: CropRect
    trim: TrimRange
    flip: FlipState
    scale: OutputSize
    upscaleQuality: UpscaleQuality
    simulatorExtend: boolean
  }>
}

export type BatchExportResult = {
  outputPaths: string[]
  ffmpegCommands: string[][]
}
