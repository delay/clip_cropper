import type {
  AspectPresetId,
  CropRect,
  FlipState,
  OutputSize,
  TrimRange,
  UpscaleQuality,
} from './types'

export const SIMULATOR_EXTEND_OUTPUT = {
  width: 5760,
  height: 1080,
} as const

export const SIMULATOR_CENTER_OUTPUT = {
  width: 1920,
  height: 1080,
} as const

const SIMULATOR_EDGE_SAMPLE_WIDTH = 308
const SIMULATOR_SIDE_WIDTH = (SIMULATOR_EXTEND_OUTPUT.width - SIMULATOR_CENTER_OUTPUT.width) / 2

export const ASPECT_PRESETS: Array<{
  id: AspectPresetId
  label: string
  ratio?: number
}> = [
  { id: 'source', label: 'Source Aspect' },
  { id: 'widescreen', label: '1920 × 1080', ratio: 1920 / 1080 },
  { id: 'ultrawide', label: '2560 × 1080', ratio: 2560 / 1080 },
  { id: 'square', label: 'Square', ratio: 1 },
  { id: 'triple', label: '5760 × 1080', ratio: 5760 / 1080 },
]

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function makeEven(value: number) {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export function getAspectRatio(
  preset: AspectPresetId,
  sourceWidth: number,
  sourceHeight: number,
) {
  const presetConfig = ASPECT_PRESETS.find((entry) => entry.id === preset)
  if (presetConfig?.ratio) {
    return presetConfig.ratio
  }

  if (sourceWidth > 0 && sourceHeight > 0) {
    return sourceWidth / sourceHeight
  }

  return 16 / 9
}

export function createDefaultCrop(
  sourceWidth: number,
  sourceHeight: number,
  ratio: number,
): CropRect {
  if (!sourceWidth || !sourceHeight) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }

  const safeRatio = Math.max(0.1, ratio)
  let width = sourceWidth
  let height = width / safeRatio

  if (height > sourceHeight) {
    height = sourceHeight
    width = height * safeRatio
  }

  return {
    x: (sourceWidth - width) / 2,
    y: (sourceHeight - height) / 2,
    width,
    height,
  }
}

export function fitCropToBounds(
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
): CropRect {
  const width = clamp(crop.width, 2, sourceWidth)
  const height = clamp(crop.height, 2, sourceHeight)

  return {
    x: clamp(crop.x, 0, sourceWidth - width),
    y: clamp(crop.y, 0, sourceHeight - height),
    width,
    height,
  }
}

export function fitCropToRatio(
  crop: CropRect,
  ratio: number,
  sourceWidth: number,
  sourceHeight: number,
): CropRect {
  const centerX = crop.x + crop.width / 2
  const centerY = crop.y + crop.height / 2
  const candidateFromWidth = crop.width / ratio
  const candidateFromHeight = crop.height * ratio

  let width =
    candidateFromWidth <= crop.height ? crop.width : Math.min(candidateFromHeight, crop.width)
  let height = width / ratio

  if (height > sourceHeight) {
    height = sourceHeight
    width = height * ratio
  }

  if (width > sourceWidth) {
    width = sourceWidth
    height = width / ratio
  }

  return fitCropToBounds(
    {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
    },
    sourceWidth,
    sourceHeight,
  )
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return '00:00.000'
  }

  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000))
  const minutes = Math.floor(totalMilliseconds / 60000)
  const secs = Math.floor((totalMilliseconds % 60000) / 1000)
  const millis = totalMilliseconds % 1000
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

export function formatFrameRate(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) {
    return 'Unknown'
  }

  return fps >= 10 ? `${fps.toFixed(2)} fps` : `${fps.toFixed(3)} fps`
}

export function getMinCropSize(sourceWidth: number, sourceHeight: number) {
  return Math.max(48, Math.round(Math.min(sourceWidth, sourceHeight) * 0.08))
}

type Handle = 'nw' | 'ne' | 'se' | 'sw'

export function moveCrop(
  crop: CropRect,
  deltaX: number,
  deltaY: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  return fitCropToBounds(
    {
      ...crop,
      x: crop.x + deltaX,
      y: crop.y + deltaY,
    },
    sourceWidth,
    sourceHeight,
  )
}

export function resizeCropFreeform(
  crop: CropRect,
  handle: Handle,
  pointX: number,
  pointY: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  const minSize = getMinCropSize(sourceWidth, sourceHeight)
  let left = crop.x
  let right = crop.x + crop.width
  let top = crop.y
  let bottom = crop.y + crop.height

  if (handle.includes('w')) {
    left = clamp(pointX, 0, right - minSize)
  } else {
    right = clamp(pointX, left + minSize, sourceWidth)
  }

  if (handle.includes('n')) {
    top = clamp(pointY, 0, bottom - minSize)
  } else {
    bottom = clamp(pointY, top + minSize, sourceHeight)
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

export function resizeCropLocked(
  crop: CropRect,
  handle: Handle,
  deltaX: number,
  deltaY: number,
  ratio: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  const minWidth = getMinCropSize(sourceWidth, sourceHeight)
  const minHeight = minWidth / ratio

  const anchor =
    handle === 'se'
      ? { x: crop.x, y: crop.y }
      : handle === 'sw'
        ? { x: crop.x + crop.width, y: crop.y }
        : handle === 'ne'
          ? { x: crop.x, y: crop.y + crop.height }
          : { x: crop.x + crop.width, y: crop.y + crop.height }

  const widthFromX = crop.width + (handle.includes('e') ? deltaX : -deltaX)
  const heightFromY = crop.height + (handle.includes('s') ? deltaY : -deltaY)
  const widthFromY = heightFromY * ratio
  const drivenByX = Math.abs(widthFromX - crop.width) >= Math.abs(widthFromY - crop.width)

  const horizontalLimit = handle.includes('e') ? sourceWidth - anchor.x : anchor.x
  const verticalLimit = handle.includes('s') ? sourceHeight - anchor.y : anchor.y
  const maxWidth = Math.max(minWidth, Math.min(horizontalLimit, verticalLimit * ratio))

  let width = clamp(drivenByX ? widthFromX : widthFromY, minWidth, maxWidth)
  let height = width / ratio

  if (height < minHeight) {
    height = minHeight
    width = height * ratio
  }

  if (handle === 'se') {
    return { x: anchor.x, y: anchor.y, width, height }
  }

  if (handle === 'sw') {
    return { x: anchor.x - width, y: anchor.y, width, height }
  }

  if (handle === 'ne') {
    return { x: anchor.x, y: anchor.y - height, width, height }
  }

  return { x: anchor.x - width, y: anchor.y - height, width, height }
}

export function normalizeCropForExport(
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
) {
  let width = makeEven(Math.min(crop.width, sourceWidth))
  let height = makeEven(Math.min(crop.height, sourceHeight))
  let x = Math.max(0, Math.round(crop.x))
  let y = Math.max(0, Math.round(crop.y))

  if (width > sourceWidth) {
    width = makeEven(sourceWidth)
  }

  if (height > sourceHeight) {
    height = makeEven(sourceHeight)
  }

  x = clamp(x, 0, Math.max(0, sourceWidth - width))
  y = clamp(y, 0, Math.max(0, sourceHeight - height))

  if (x % 2 !== 0) {
    x = Math.max(0, x - 1)
  }

  if (y % 2 !== 0) {
    y = Math.max(0, y - 1)
  }

  if (x + width > sourceWidth) {
    x = Math.max(0, sourceWidth - width)
  }

  if (y + height > sourceHeight) {
    y = Math.max(0, sourceHeight - height)
  }

  return { x, y, width, height }
}

export function getPresetExportSize(
  preset: AspectPresetId,
  ratio: number,
) {
  if (preset === 'widescreen') {
    return {
      width: 1920,
      height: 1080,
      label: 'Scale to 1920 × 1080',
    }
  }

  if (preset === 'square') {
    return {
      width: 1080,
      height: 1080,
      label: 'Scale to 1080 × 1080',
    }
  }

  if (preset === 'ultrawide') {
    return {
      width: 2560,
      height: 1080,
      label: 'Scale to 2560 × 1080',
    }
  }

  if (preset === 'triple') {
    return {
      width: 5760,
      height: 1080,
      label: 'Scale to 5760 × 1080',
    }
  }

  const targetHeight = 1080
  return {
    width: makeEven(targetHeight * ratio),
    height: targetHeight,
    label: `Scale to ${makeEven(targetHeight * ratio)} × ${targetHeight}`,
  }
}

export function getCropSummaryLabel(preset: AspectPresetId, ratio: number) {
  if (preset === 'source') {
    return 'Source aspect'
  }

  return `${ratio.toFixed(3)} : 1`
}

export function buildFilterChain(
  crop: CropRect,
  flip: FlipState,
  scale: OutputSize,
  upscaleQuality: UpscaleQuality,
) {
  const filters = [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`]

  if (flip.horizontal) {
    filters.push('hflip')
  }

  if (flip.vertical) {
    filters.push('vflip')
  }

  if (scale.width !== crop.width || scale.height !== crop.height) {
    if (upscaleQuality === 'high') {
      filters.push(`scale=${scale.width}:${scale.height}:flags=lanczos`)
      filters.push('unsharp=5:5:0.6:5:5:0.0')
    } else {
      filters.push(`scale=${scale.width}:${scale.height}`)
    }
  }

  filters.push('setsar=1')

  return filters.join(',')
}

function formatCliTime(seconds: number) {
  return Math.max(0, seconds).toFixed(3)
}

function buildSimulatorFilterPreview(crop: CropRect, flip: FlipState) {
  const scaledFilters = [
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    flip.horizontal ? 'hflip' : null,
    flip.vertical ? 'vflip' : null,
    `scale=${SIMULATOR_CENTER_OUTPUT.width}:${SIMULATOR_CENTER_OUTPUT.height}:flags=lanczos`,
  ]
    .filter(Boolean)
    .join(',')

  return [
    `[0:v]${scaledFilters},split=3[center][leftsrc][rightsrc]`,
    `[leftsrc]crop='if(gte(iw,${SIMULATOR_EDGE_SAMPLE_WIDTH}),${SIMULATOR_EDGE_SAMPLE_WIDTH},iw)':ih:0:0,scale=${SIMULATOR_SIDE_WIDTH}:${SIMULATOR_EXTEND_OUTPUT.height}:flags=lanczos,gblur=sigma=55,eq=brightness=-0.07[left]`,
    `[rightsrc]crop='if(gte(iw,${SIMULATOR_EDGE_SAMPLE_WIDTH}),${SIMULATOR_EDGE_SAMPLE_WIDTH},iw)':ih:'if(gte(iw,${SIMULATOR_EDGE_SAMPLE_WIDTH}),iw-${SIMULATOR_EDGE_SAMPLE_WIDTH},0)':0,scale=${SIMULATOR_SIDE_WIDTH}:${SIMULATOR_EXTEND_OUTPUT.height}:flags=lanczos,gblur=sigma=55,eq=brightness=-0.07[right]`,
    `[left][center][right]hstack=inputs=3,setsar=1[vout]`,
  ].join(';')
}

export function buildFfmpegPreview(
  inputName: string,
  outputName: string,
  trim: TrimRange,
  crop: CropRect,
  flip: FlipState,
  scale: OutputSize,
  upscaleQuality: UpscaleQuality,
  simulatorExtend: boolean,
  includeAudio: boolean,
) {
  const filters = simulatorExtend
    ? buildSimulatorFilterPreview(crop, flip)
    : buildFilterChain(crop, flip, scale, upscaleQuality)
  const audioArgs = includeAudio ? ['-c:a aac', '-b:a 192k'] : ['-an']
  const trimDuration = Math.max(0, trim.end - trim.start)

  return [
    'ffmpeg',
    `-i "${inputName}"`,
    `-ss ${formatCliTime(trim.start)}`,
    `-t ${formatCliTime(trimDuration)}`,
    simulatorExtend ? `-filter_complex "${filters}"` : `-vf "${filters}"`,
    ...(simulatorExtend ? ['-map "[vout]"', includeAudio ? '-map 0:a?' : null].filter(Boolean) : []),
    '-c:v libx264',
    '-crf 18',
    '-preset medium',
    ...audioArgs,
    '-movflags +faststart',
    `"${outputName}"`,
  ].join(' ')
}
