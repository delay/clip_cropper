import { useEffect, useMemo, useRef, useState } from 'react'

import './App.css'
import {
  ASPECT_PRESETS,
  SIMULATOR_EXTEND_OUTPUT,
  buildFfmpegPreview,
  clamp,
  createDefaultCrop,
  fitCropToBounds,
  fitCropToRatio,
  formatFrameRate,
  formatTime,
  getAspectRatio,
  getCropSummaryLabel,
  getPresetExportSize,
  moveCrop,
  normalizeCropForExport,
  resizeCropFreeform,
  resizeCropLocked,
} from './lib/editor'
import {
  exportVideoBatchFromDesktop,
  exportVideoFromDesktop,
  isDesktopRuntime,
  listenToExportProgress,
  pickVideoFromDesktop,
} from './lib/tauri'
import type {
  AspectPresetId,
  BatchExportPayload,
  CropRect,
  ExportPayload,
  ExportProgress,
  FlipState,
  SavedSelection,
  TrimRange,
  UpscaleQuality,
  VideoSource,
} from './lib/types'

type PointerAction =
  | {
      kind: 'move'
      startCrop: CropRect
      startPoint: { x: number; y: number }
    }
  | {
      kind: 'resize'
      handle: 'nw' | 'ne' | 'se' | 'sw'
      startCrop: CropRect
      startPoint: { x: number; y: number }
    }

type TrimPointerAction = {
  kind: 'start' | 'end' | 'playhead' | 'range'
  startClientX: number
  startTrim: TrimRange
  startTime: number
}

type SelectionExportClip = {
  id: string
  name: string
  crop: CropRect
  trim: TrimRange
  flip: FlipState
  upscaleQuality: UpscaleQuality
  simulatorExtend: boolean
  scale: {
    width: number
    height: number
  }
}

const PLACEHOLDER_THUMBS = 14

function getFileStem(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, '')
}

function formatExportPercent(progress: number) {
  return `${Math.round(clamp(progress, 0, 1) * 100)}%`
}

function waitForVideoLoad(video: HTMLVideoElement) {
  if (video.readyState >= 2) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const handleLoaded = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error('Could not read video frames.'))
    }

    const cleanup = () => {
      video.removeEventListener('loadeddata', handleLoaded)
      video.removeEventListener('error', handleError)
    }

    video.addEventListener('loadeddata', handleLoaded, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const handleSeeked = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error('Could not seek video.'))
    }

    const cleanup = () => {
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
    }

    video.addEventListener('seeked', handleSeeked, { once: true })
    video.addEventListener('error', handleError, { once: true })
    video.currentTime = time
  })
}

async function buildSelectionThumbnail(
  sourceUrl: string,
  sourceWidth: number,
  sourceHeight: number,
  crop: CropRect,
  trim: TrimRange,
  flip: FlipState,
) {
  const sourceVideo = document.createElement('video')
  sourceVideo.src = sourceUrl
  sourceVideo.crossOrigin = 'anonymous'
  sourceVideo.muted = true
  sourceVideo.playsInline = true
  sourceVideo.preload = 'auto'

  await waitForVideoLoad(sourceVideo)

  const midpoint = clamp(trim.start + (trim.end - trim.start) / 2, 0, Math.max(trim.end - 0.05, 0))
  await seekVideo(sourceVideo, midpoint)

  const safeCrop = normalizeCropForExport(crop, sourceWidth, sourceHeight)
  const maxWidth = 220
  const thumbnailWidth = maxWidth
  const thumbnailHeight = Math.max(88, Math.round(thumbnailWidth / (safeCrop.width / safeCrop.height)))
  const canvas = document.createElement('canvas')
  canvas.width = thumbnailWidth
  canvas.height = thumbnailHeight
  const context = canvas.getContext('2d')

  if (!context) {
    return ''
  }

  context.fillStyle = '#0a1118'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.save()
  if (flip.horizontal || flip.vertical) {
    context.translate(flip.horizontal ? canvas.width : 0, flip.vertical ? canvas.height : 0)
    context.scale(flip.horizontal ? -1 : 1, flip.vertical ? -1 : 1)
  }
  context.drawImage(
    sourceVideo,
    safeCrop.x,
    safeCrop.y,
    safeCrop.width,
    safeCrop.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  context.restore()

  return canvas.toDataURL('image/jpeg', 0.82)
}

function App() {
  const desktopRuntime = isDesktopRuntime()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const trimStripRef = useRef<HTMLDivElement>(null)
  const objectUrlRef = useRef<string | null>(null)
  const pointerActionRef = useRef<PointerAction | null>(null)
  const trimPointerActionRef = useRef<TrimPointerAction | null>(null)
  const [video, setVideo] = useState<VideoSource | null>(null)
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [trim, setTrim] = useState<TrimRange>({ start: 0, end: 0 })
  const [aspectPreset, setAspectPreset] = useState<AspectPresetId>('source')
  const [scaleMode, setScaleMode] = useState<'crop' | 'preset'>('crop')
  const [upscaleQuality, setUpscaleQuality] = useState<UpscaleQuality>('standard')
  const [simulatorExtend, setSimulatorExtend] = useState(false)
  const [flip, setFlip] = useState<FlipState>({
    horizontal: false,
    vertical: false,
  })
  const [ratioLocked, setRatioLocked] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [previewingRange, setPreviewingRange] = useState(false)
  const [status, setStatus] = useState('Open a clip to start.')
  const [lastExportPath, setLastExportPath] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 })
  const [timelineThumbnails, setTimelineThumbnails] = useState<string[]>([])
  const [savedSelections, setSavedSelections] = useState<SavedSelection[]>([])
  const [activeSelectionId, setActiveSelectionId] = useState<string | null>(null)
  const [exportMode, setExportMode] = useState<'continuous' | 'individual'>('continuous')

  const handleSimulatorExtendChange = (checked: boolean) => {
    setSimulatorExtend(checked)
  }

  const aspectRatio = useMemo(
    () => getAspectRatio(aspectPreset, video?.width ?? 0, video?.height ?? 0),
    [aspectPreset, video?.height, video?.width],
  )

  const aspectPresetLabel = useMemo(
    () => ASPECT_PRESETS.find((preset) => preset.id === aspectPreset)?.label ?? 'Source Aspect',
    [aspectPreset],
  )

  const normalizedCrop = useMemo(() => {
    if (!video || !crop) {
      return null
    }

    return normalizeCropForExport(crop, video.width, video.height)
  }, [crop, video])

  const presetOutput = useMemo(() => {
    if (!normalizedCrop) {
      return null
    }

    return getPresetExportSize(aspectPreset, aspectRatio)
  }, [aspectPreset, aspectRatio, normalizedCrop])

  const selectedOutput = useMemo(() => {
    if (!normalizedCrop) {
      return null
    }

    if (simulatorExtend) {
      return SIMULATOR_EXTEND_OUTPUT
    }

    return scaleMode === 'crop' ? normalizedCrop : presetOutput
  }, [normalizedCrop, presetOutput, scaleMode, simulatorExtend])

  const selectionExportClips = useMemo(() => {
    if (!video) {
      return [] as SelectionExportClip[]
    }

    return savedSelections.map((selection) => {
      const selectionUpscaleQuality = selection.upscaleQuality ?? 'standard'
      const selectionCrop = normalizeCropForExport(selection.crop, video.width, video.height)
      const selectionRatio = getAspectRatio(selection.aspectPreset, video.width, video.height)
      const selectionScale =
        selection.scaleMode === 'crop'
          ? selectionCrop
          : getPresetExportSize(selection.aspectPreset, selectionRatio)

      return {
        id: selection.id,
        name: selection.name,
        crop: selectionCrop,
        trim: selection.trim,
        flip: selection.flip,
        upscaleQuality: selectionUpscaleQuality,
        simulatorExtend: selection.simulatorExtend,
        scale: {
          width: selection.simulatorExtend ? SIMULATOR_EXTEND_OUTPUT.width : selectionScale.width,
          height: selection.simulatorExtend ? SIMULATOR_EXTEND_OUTPUT.height : selectionScale.height,
        },
      }
    })
  }, [savedSelections, video])

  const continuousExportAvailable = useMemo(() => {
    if (selectionExportClips.length <= 1) {
      return true
    }

    const [firstClip, ...otherClips] = selectionExportClips
    return otherClips.every(
      (clip) =>
        clip.scale.width === firstClip.scale.width && clip.scale.height === firstClip.scale.height,
    )
  }, [selectionExportClips])

  const cropStyle = useMemo(() => {
    if (!video || !crop) {
      return undefined
    }

    return {
      left: `${(crop.x / video.width) * 100}%`,
      top: `${(crop.y / video.height) * 100}%`,
      width: `${(crop.width / video.width) * 100}%`,
      height: `${(crop.height / video.height) * 100}%`,
    }
  }, [crop, video])

  const exportCommand = useMemo(() => {
    if (!video || !normalizedCrop || !selectedOutput) {
      return ''
    }

    return buildFfmpegPreview(
      video.name,
      `${getFileStem(video.name)}-export.mp4`,
      trim,
      normalizedCrop,
      flip,
      {
        width: selectedOutput.width,
        height: selectedOutput.height,
      },
      upscaleQuality,
      simulatorExtend,
      video.hasAudio,
    )
  }, [flip, normalizedCrop, selectedOutput, simulatorExtend, trim, upscaleQuality, video])

  const trimMinimumGap = useMemo(() => {
    if (!video) {
      return 0.04
    }

    const frameGap = video.fps > 0 ? 1 / video.fps : 1 / 30
    return Math.max(frameGap, 0.04)
  }, [video])

  const trimStartPercent = useMemo(() => {
    if (!video?.duration) {
      return 0
    }

    return (trim.start / video.duration) * 100
  }, [trim.start, video])

  const trimEndPercent = useMemo(() => {
    if (!video?.duration) {
      return 100
    }

    return (trim.end / video.duration) * 100
  }, [trim.end, video])

  const playheadPercent = useMemo(() => {
    if (!video?.duration) {
      return 0
    }

    return (clamp(currentTime, 0, video.duration) / video.duration) * 100
  }, [currentTime, video])

  useEffect(() => {
    if (!previewRef.current) {
      return
    }

    const observer = new ResizeObserver(([entry]) => {
      setPreviewSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    })

    observer.observe(previewRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!desktopRuntime) {
      return
    }

    let cancelled = false
    let unlisten: (() => void) | undefined

    void listenToExportProgress((progress) => {
      if (!cancelled) {
        setExportProgress(progress)
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose()
        return
      }

      unlisten = dispose
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [desktopRuntime])

  useEffect(() => {
    if (!video || video.width <= 0 || video.height <= 0) {
      setTimelineThumbnails([])
      return
    }

    let cancelled = false

    const generateThumbnails = async () => {
      try {
        const sourceVideo = document.createElement('video')
        sourceVideo.src = video.sourceUrl
        sourceVideo.crossOrigin = 'anonymous'
        sourceVideo.muted = true
        sourceVideo.playsInline = true
        sourceVideo.preload = 'auto'

        await waitForVideoLoad(sourceVideo)

        const frameCount = PLACEHOLDER_THUMBS
        const frameWidth = 96
        const canvas = document.createElement('canvas')
        canvas.width = frameWidth
        canvas.height = Math.max(54, Math.round(frameWidth / (video.width / video.height)))
        const context = canvas.getContext('2d')

        if (!context) {
          return
        }

        const thumbnails: string[] = []
        for (let index = 0; index < frameCount; index += 1) {
          const progress = index / (frameCount - 1)
          const time = Math.min(
            Math.max(0, progress * video.duration),
            Math.max(video.duration - 0.05, 0),
          )

          await seekVideo(sourceVideo, time)
          context.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height)
          thumbnails.push(canvas.toDataURL('image/jpeg', 0.78))
        }

        if (!cancelled) {
          setTimelineThumbnails(thumbnails)
        }
      } catch {
        if (!cancelled) {
          setTimelineThumbnails([])
        }
      }
    }

    void generateThumbnails()

    return () => {
      cancelled = true
    }
  }, [video])

  useEffect(() => {
    if (!video || video.width <= 0 || video.height <= 0) {
      return
    }

    setCrop((currentCrop) => {
      if (!currentCrop) {
        return createDefaultCrop(video.width, video.height, aspectRatio)
      }

      return ratioLocked
        ? fitCropToRatio(currentCrop, aspectRatio, video.width, video.height)
        : fitCropToBounds(currentCrop, video.width, video.height)
    })
  }, [aspectRatio, ratioLocked, video])

  useEffect(() => {
    const element = videoRef.current

    if (!element || !previewingRange) {
      return
    }

    const stopAtOutPoint = () => {
      if (element.currentTime >= trim.end) {
        element.pause()
        element.currentTime = trim.start
        setCurrentTime(trim.start)
        setPreviewingRange(false)
      }
    }

    element.addEventListener('timeupdate', stopAtOutPoint)
    return () => element.removeEventListener('timeupdate', stopAtOutPoint)
  }, [previewingRange, trim.end, trim.start])

  const setVideoSource = (nextVideo: VideoSource) => {
    const sourceAspectRatio = nextVideo.width / nextVideo.height
    setVideo(nextVideo)
    setAspectPreset('source')
    setRatioLocked(true)
    setCrop(createDefaultCrop(nextVideo.width, nextVideo.height, sourceAspectRatio))
    setTrim({ start: 0, end: nextVideo.duration })
    setCurrentTime(0)
    setPreviewingRange(false)
    setScaleMode('crop')
    setSimulatorExtend(false)
    setSavedSelections([])
    setActiveSelectionId(null)
    setLastExportPath(null)
    setStatus(`Loaded ${nextVideo.name}`)
  }

  const openClip = async () => {
    if (desktopRuntime) {
      try {
        const selected = await pickVideoFromDesktop()
        if (selected) {
          setVideoSource(selected)
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open clip.')
      }
      return
    }

    fileInputRef.current?.click()
  }

  const handleLocalFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
    }

    const objectUrl = URL.createObjectURL(file)
    objectUrlRef.current = objectUrl

    setVideo({
      name: file.name,
      sourceUrl: objectUrl,
      width: 0,
      height: 0,
      duration: 0,
      fps: 30,
      hasAudio: true,
    })
    setAspectPreset('source')
    setRatioLocked(true)
    setCrop(null)
    setTrim({ start: 0, end: 0 })
    setCurrentTime(0)
    setSimulatorExtend(false)
    setSavedSelections([])
    setActiveSelectionId(null)
    setStatus(`Loaded ${file.name} in browser preview mode.`)
    event.target.value = ''
  }

  const handleMetadataLoaded = () => {
    const element = videoRef.current

    if (!element || !video) {
      return
    }

    const nextVideo = {
      ...video,
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration,
    }
    const sourceAspectRatio = nextVideo.width / nextVideo.height

    setVideo(nextVideo)
    setCrop((currentCrop) =>
      currentCrop
        ? fitCropToBounds(currentCrop, nextVideo.width, nextVideo.height)
        : createDefaultCrop(nextVideo.width, nextVideo.height, sourceAspectRatio),
    )
    setTrim((currentRange) => {
      const end =
        currentRange.end > 0 ? Math.min(currentRange.end, nextVideo.duration) : nextVideo.duration
      return {
        start: clamp(currentRange.start, 0, nextVideo.duration),
        end: clamp(end, 0, nextVideo.duration),
      }
    })
  }

  const handleTimeUpdate = () => {
    const element = videoRef.current

    if (!element) {
      return
    }

    setCurrentTime(element.currentTime)
  }

  const seekTo = (time: number) => {
    const element = videoRef.current

    if (!element || !video) {
      return
    }

    const nextTime = clamp(time, 0, video.duration)
    element.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const togglePreviewPlayback = () => {
    const element = videoRef.current

    if (!element || !video) {
      return
    }

    if (element.paused) {
      setPreviewingRange(false)
      void element.play()
      setIsPlaying(true)
      return
    }

    element.pause()
    setIsPlaying(false)
  }

  const toggleTrimPlayback = () => {
    const element = videoRef.current

    if (!element || !video) {
      return
    }

    if (element.paused) {
      const resumeTime =
        currentTime >= trim.start && currentTime <= trim.end ? currentTime : trim.start
      element.currentTime = resumeTime
      setCurrentTime(resumeTime)
      setPreviewingRange(true)
      void element.play()
      setIsPlaying(true)
      return
    }

    element.pause()
    setPreviewingRange(false)
    setIsPlaying(false)
  }

  const playTrimmedRange = () => {
    const element = videoRef.current

    if (!element || !video) {
      return
    }

    element.currentTime = trim.start
    setCurrentTime(trim.start)
    setPreviewingRange(true)
    void element.play()
    setIsPlaying(true)
  }

  const nudgeFrame = (direction: -1 | 1) => {
    const step = video?.fps && video.fps > 0 ? 1 / video.fps : 1 / 30
    seekTo(currentTime + step * direction)
  }

  const setInPoint = () => {
    setTrim((current) => ({
      start: Math.min(currentTime, current.end - trimMinimumGap),
      end: current.end,
    }))
  }

  const setOutPoint = () => {
    setTrim((current) => ({
      start: current.start,
      end: Math.max(currentTime, current.start + trimMinimumGap),
    }))
  }

  const resetTrimRange = () => {
    if (!video) {
      return
    }

    setTrim({ start: 0, end: video.duration })
    seekTo(0)
  }

  const getSourcePoint = (clientX: number, clientY: number) => {
    if (!video || !previewRef.current) {
      return null
    }

    const bounds = previewRef.current.getBoundingClientRect()
    const normalizedX = clamp((clientX - bounds.left) / bounds.width, 0, 1)
    const normalizedY = clamp((clientY - bounds.top) / bounds.height, 0, 1)

    return {
      x: flip.horizontal ? video.width - normalizedX * video.width : normalizedX * video.width,
      y: flip.vertical ? video.height - normalizedY * video.height : normalizedY * video.height,
    }
  }

  const finishPointerAction = () => {
    pointerActionRef.current = null
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', finishPointerAction)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (!video || !crop || !pointerActionRef.current) {
      return
    }

    const sourcePoint = getSourcePoint(event.clientX, event.clientY)

    if (!sourcePoint) {
      return
    }

    const action = pointerActionRef.current
    const deltaX = sourcePoint.x - action.startPoint.x
    const deltaY = sourcePoint.y - action.startPoint.y

    if (action.kind === 'move') {
      setCrop(moveCrop(action.startCrop, deltaX, deltaY, video.width, video.height))
      return
    }

    setCrop(
      ratioLocked
        ? resizeCropLocked(
            action.startCrop,
            action.handle,
            deltaX,
            deltaY,
            aspectRatio,
            video.width,
            video.height,
          )
        : resizeCropFreeform(
            action.startCrop,
            action.handle,
            sourcePoint.x,
            sourcePoint.y,
            video.width,
            video.height,
          ),
    )
  }

  const startPointerAction = (
    event: React.PointerEvent<HTMLDivElement>,
    nextAction: PointerAction,
  ) => {
    event.preventDefault()
    pointerActionRef.current = nextAction
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishPointerAction)
  }

  const startMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const sourcePoint = getSourcePoint(event.clientX, event.clientY)

    if (!crop || !sourcePoint) {
      return
    }

    startPointerAction(event, {
      kind: 'move',
      startCrop: crop,
      startPoint: sourcePoint,
    })
  }

  const startResize = (
    handle: 'nw' | 'ne' | 'se' | 'sw',
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation()
    const sourcePoint = getSourcePoint(event.clientX, event.clientY)

    if (!crop || !sourcePoint) {
      return
    }

    startPointerAction(event, {
      kind: 'resize',
      handle,
      startCrop: crop,
      startPoint: sourcePoint,
    })
  }

  const getTrimMetrics = () => {
    if (!trimStripRef.current || !video?.duration) {
      return null
    }

    const bounds = trimStripRef.current.getBoundingClientRect()
    return {
      left: bounds.left,
      width: bounds.width,
      duration: video.duration,
    }
  }

  const trimClientXToTime = (clientX: number) => {
    const metrics = getTrimMetrics()

    if (!metrics) {
      return null
    }

    const progress = clamp((clientX - metrics.left) / metrics.width, 0, 1)
    return progress * metrics.duration
  }

  const stopTrimPointerAction = () => {
    trimPointerActionRef.current = null
    window.removeEventListener('pointermove', handleTrimPointerMove)
    window.removeEventListener('pointerup', stopTrimPointerAction)
  }

  const handleTrimPointerMove = (event: PointerEvent) => {
    if (!video || !trimPointerActionRef.current) {
      return
    }

    const action = trimPointerActionRef.current
    const time = trimClientXToTime(event.clientX)

    if (time === null) {
      return
    }

    if (action.kind === 'playhead') {
      seekTo(time)
      return
    }

    if (action.kind === 'start') {
      const nextStart = clamp(time, 0, action.startTrim.end - trimMinimumGap)
      setTrim({
        start: nextStart,
        end: action.startTrim.end,
      })
      seekTo(nextStart)
      return
    }

    if (action.kind === 'end') {
      const nextEnd = clamp(time, action.startTrim.start + trimMinimumGap, video.duration)
      setTrim({
        start: action.startTrim.start,
        end: nextEnd,
      })
      seekTo(nextEnd)
      return
    }

    const metrics = getTrimMetrics()
    if (!metrics) {
      return
    }

    const deltaProgress = (event.clientX - action.startClientX) / metrics.width
    const deltaTime = deltaProgress * metrics.duration
    const rangeDuration = action.startTrim.end - action.startTrim.start
    const nextStart = clamp(action.startTrim.start + deltaTime, 0, video.duration - rangeDuration)
    const nextEnd = nextStart + rangeDuration
    const nextTime = clamp(action.startTime + deltaTime, nextStart, nextEnd)

    setTrim({
      start: nextStart,
      end: nextEnd,
    })
    seekTo(nextTime)
  }

  const beginTrimPointerAction = (
    event: React.PointerEvent<HTMLElement>,
    kind: TrimPointerAction['kind'],
  ) => {
    if (!video) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    videoRef.current?.pause()
    setPreviewingRange(false)
    setIsPlaying(false)
    trimPointerActionRef.current = {
      kind,
      startClientX: event.clientX,
      startTrim: trim,
      startTime: currentTime,
    }
    window.addEventListener('pointermove', handleTrimPointerMove)
    window.addEventListener('pointerup', stopTrimPointerAction)
  }

  const handleTrimTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const time = trimClientXToTime(event.clientX)

    if (time === null) {
      return
    }

    seekTo(time)
    beginTrimPointerAction(event, 'playhead')
  }

  const loadSelectionIntoEditor = (selection: SavedSelection) => {
    setActiveSelectionId(selection.id)
    setAspectPreset(selection.aspectPreset)
    setScaleMode(selection.scaleMode)
    setUpscaleQuality(selection.upscaleQuality ?? 'standard')
    setSimulatorExtend(selection.simulatorExtend)
    setFlip(selection.flip)
    setTrim(selection.trim)
    setCrop(selection.crop)
    seekTo(selection.trim.start)
    setStatus(`Loaded ${selection.name} for adjustment.`)
  }

  const saveSelection = async (mode: 'new' | 'update') => {
    if (!video || !normalizedCrop) {
      return
    }

    const thumbnailUrl = await buildSelectionThumbnail(
      video.sourceUrl,
      video.width,
      video.height,
      normalizedCrop,
      trim,
      flip,
    )

    const selectionName =
      mode === 'update' && activeSelectionId
        ? savedSelections.find((selection) => selection.id === activeSelectionId)?.name ?? 'Clip'
        : `Clip ${savedSelections.length + 1}`

    const nextSelection: SavedSelection = {
      id:
        mode === 'update' && activeSelectionId
          ? activeSelectionId
          : globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
      name: selectionName,
      crop: normalizedCrop,
      trim,
      flip,
      aspectPreset,
      scaleMode,
      upscaleQuality,
      simulatorExtend,
      thumbnailUrl,
    }

    if (mode === 'update' && activeSelectionId) {
      setSavedSelections((current) =>
        current.map((selection) => (selection.id === activeSelectionId ? nextSelection : selection)),
      )
      setStatus(`Updated ${selectionName}.`)
      return
    }

    setSavedSelections((current) => [...current, nextSelection])
    setActiveSelectionId(nextSelection.id)
    setStatus(`Saved ${selectionName}.`)
  }

  const removeSelection = (selectionId: string) => {
    setSavedSelections((current) => current.filter((selection) => selection.id !== selectionId))
    if (activeSelectionId === selectionId) {
      setActiveSelectionId(null)
    }
  }

  const exportSelections = async () => {
    if (!video?.path || selectionExportClips.length === 0) {
      return
    }

    const payload: BatchExportPayload = {
      inputPath: video.path,
      baseFilename: getFileStem(video.name),
      exportMode,
      includeAudio: video.hasAudio,
      clips: selectionExportClips.map((clip) => ({
        name: clip.name,
        crop: clip.crop,
        trim: clip.trim,
        flip: clip.flip,
        scale: clip.scale,
        upscaleQuality: clip.upscaleQuality,
        simulatorExtend: clip.simulatorExtend,
      })),
    }

    setIsExporting(true)
    setExportProgress({
      currentStep: 1,
      totalSteps: exportMode === 'continuous' ? selectionExportClips.length + 1 : selectionExportClips.length,
      stepLabel: 'Preparing export',
      stepProgress: 0,
      overallProgress: 0,
    })
    setStatus(
      exportMode === 'continuous'
        ? 'Preparing continuous export...'
        : `Preparing ${selectionExportClips.length}-clip export...`,
    )

    try {
      const result = await exportVideoBatchFromDesktop(payload)
      if (result?.outputPaths.length) {
        setLastExportPath(result.outputPaths.join(', '))
        setStatus(
          exportMode === 'continuous'
            ? `Exported continuous sequence.`
            : `Exported ${result.outputPaths.length} clips.`,
        )
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Batch export failed.')
    } finally {
      setIsExporting(false)
    }
  }

  const exportSingleClip = async () => {
    if (!video?.path || !normalizedCrop || !selectedOutput) {
      return
    }

    const payload: ExportPayload = {
      inputPath: video.path,
      suggestedFilename: `${getFileStem(video.name)}-${aspectPreset}.mp4`,
      crop: normalizedCrop,
      trim,
      flip,
      scale: {
        width: selectedOutput.width,
        height: selectedOutput.height,
      },
      upscaleQuality,
      simulatorExtend,
      includeAudio: video.hasAudio,
    }

    setIsExporting(true)
    setExportProgress({
      currentStep: 1,
      totalSteps: 1,
      stepLabel: 'Preparing export',
      stepProgress: 0,
      overallProgress: 0,
    })
    setStatus('Preparing export...')

    try {
      const result = await exportVideoFromDesktop(payload)
      if (result) {
        setLastExportPath(result.outputPath)
        setStatus(`Exported to ${result.outputPath}`)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setIsExporting(false)
    }
  }

  const handleExport = async () => {
    if (savedSelections.length > 1) {
      await exportSelections()
      return
    }

    await exportSingleClip()
  }

  const selectionWidthPercent = Math.max(trimEndPercent - trimStartPercent, 0.8)

  return (
    <div className="editor-app">
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="video/*"
        onChange={handleLocalFileChange}
      />

      <header className="topbar">
        <div>
          <p className="eyebrow">Single-source clip builder</p>
          <h1>Clip Cropper</h1>
        </div>
        <div className="toolbar">
          <button className="tool-button tool-button--accent" onClick={openClip}>
            Open Video
          </button>
        </div>
      </header>

      <div className="status-strip">
        <span className="status-pill">{desktopRuntime ? 'Desktop runtime' : 'Browser preview'}</span>
        {video?.width ? (
          <span className="status-pill">
            {video.width} × {video.height}
          </span>
        ) : null}
        {video?.fps ? <span className="status-pill">{formatFrameRate(video.fps)}</span> : null}
        {savedSelections.length > 0 ? (
          <span className="status-pill status-pill--ok">{savedSelections.length} saved clips</span>
        ) : null}
        <span className="status-message">{status}</span>
      </div>

      <main className="video-editor-layout">
        <section className="panel panel--preview">
          <div className="panel-heading">
            <div>
              <p className="panel-label">Preview</p>
              <h2>{video ? video.name : 'No clip loaded'}</h2>
            </div>
            <div className="panel-heading__meta">
              {video ? `time ${formatTime(currentTime)} / ${formatTime(video.duration)}` : 'Load a video to begin'}
            </div>
          </div>

          <div
            ref={previewRef}
            className="preview-surface"
            style={{
              aspectRatio:
                video && video.width > 0 && video.height > 0
                  ? `${video.width} / ${video.height}`
                  : '16 / 9',
            }}
          >
            {video ? (
              <div
                className="preview-transform"
                style={{
                  transform: `scaleX(${flip.horizontal ? -1 : 1}) scaleY(${flip.vertical ? -1 : 1})`,
                }}
              >
                <video
                  ref={videoRef}
                  className="preview-video"
                  src={video.sourceUrl}
                  preload="auto"
                  playsInline
                  onLoadedMetadata={handleMetadataLoaded}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                />
                {cropStyle ? (
                  <div className="crop-box" style={cropStyle} onPointerDown={startMove}>
                    <div className="crop-box-label">
                      {Math.round(crop?.width ?? 0)} × {Math.round(crop?.height ?? 0)}
                    </div>
                    <div className="handle handle-nw" onPointerDown={(event) => startResize('nw', event)} />
                    <div className="handle handle-ne" onPointerDown={(event) => startResize('ne', event)} />
                    <div className="handle handle-se" onPointerDown={(event) => startResize('se', event)} />
                    <div className="handle handle-sw" onPointerDown={(event) => startResize('sw', event)} />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="preview-empty">
                <div className="preview-empty__content">
                  <strong>No preview clip loaded</strong>
                  <p>Save multiple selections from one source and export them as a sequence or a bundle.</p>
                  <button className="tool-button tool-button--small" onClick={openClip}>
                    Open video
                  </button>
                </div>
              </div>
            )}
          </div>

          {video ? (
            <div className="preview-controls">
              <button className="tool-button tool-button--small" onClick={() => nudgeFrame(-1)}>
                ← Frame
              </button>
              <button className="tool-button tool-button--small" onClick={togglePreviewPlayback}>
                {isPlaying && !previewingRange ? 'Pause' : 'Play'}
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(video.duration, 0)}
                step={0.01}
                value={Math.min(currentTime, Math.max(video.duration, 0))}
                onInput={(event) => {
                  setPreviewingRange(false)
                  seekTo(Number(event.currentTarget.value))
                }}
                onChange={(event) => {
                  setPreviewingRange(false)
                  seekTo(Number(event.target.value))
                }}
              />
              <button className="tool-button tool-button--small" onClick={() => nudgeFrame(1)}>
                Frame →
              </button>
            </div>
          ) : null}

          <div className="preview-footer">
            <span>preview {Math.round(previewSize.width)} × {Math.round(previewSize.height)}</span>
            <span>{aspectPresetLabel}</span>
            {selectedOutput ? (
              <span>
                export {selectedOutput.width} × {selectedOutput.height}
              </span>
            ) : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="panel-label">Trim Range</p>
              <h2>Clip timing</h2>
            </div>
            <div className="panel-heading__meta">{formatTime(Math.max(0, trim.end - trim.start))} selected</div>
          </div>

          <div className="quicktime-trim-shell">
            <button
              className="trim-play-button"
              onClick={toggleTrimPlayback}
              disabled={!video}
              aria-label={isPlaying ? 'Pause trim preview' : 'Play trim preview'}
            >
              <span className={isPlaying ? 'trim-pause-icon' : 'trim-play-icon'} />
            </button>

            <div className="trim-strip-frame">
              <div ref={trimStripRef} className="trim-track" onPointerDown={handleTrimTrackPointerDown}>
                <div className="trim-filmstrip">
                  {(timelineThumbnails.length > 0
                    ? timelineThumbnails
                    : Array.from({ length: PLACEHOLDER_THUMBS }, (_, index) => `placeholder-${index}`)
                  ).map((thumbnail, index) => (
                    <div
                      key={`${thumbnail}-${index}`}
                      className={`trim-thumb ${timelineThumbnails.length > 0 ? 'trim-thumb-image' : 'trim-thumb-placeholder'}`}
                      style={
                        timelineThumbnails.length > 0
                          ? { backgroundImage: `url(${thumbnail})` }
                          : undefined
                      }
                    />
                  ))}
                </div>

                <div className="trim-dim trim-dim-start" style={{ width: `${trimStartPercent}%` }} />
                <div className="trim-dim trim-dim-end" style={{ left: `${trimEndPercent}%`, right: 0 }} />

                <div
                  className="trim-selection"
                  style={{
                    left: `${trimStartPercent}%`,
                    width: `${selectionWidthPercent}%`,
                  }}
                  onPointerDown={(event) => beginTrimPointerAction(event, 'range')}
                >
                  <button
                    className="trim-handle trim-handle-start"
                    onPointerDown={(event) => beginTrimPointerAction(event, 'start')}
                    aria-label="Adjust trim in point"
                  >
                    <span />
                    <span />
                  </button>
                  <button
                    className="trim-handle trim-handle-end"
                    onPointerDown={(event) => beginTrimPointerAction(event, 'end')}
                    aria-label="Adjust trim out point"
                  >
                    <span />
                    <span />
                  </button>
                </div>

                <div
                  className="trim-playhead"
                  style={{ left: `${playheadPercent}%` }}
                  onPointerDown={(event) => beginTrimPointerAction(event, 'playhead')}
                >
                  <div className="trim-playhead-cap" />
                  <div className="trim-playhead-line" />
                </div>
              </div>
            </div>
          </div>

          <div className="timeline-readout-row">
            <div className="timeline-readout">
              <span>In</span>
              <strong>{formatTime(trim.start)}</strong>
            </div>
            <div className="timeline-readout">
              <span>Playhead</span>
              <strong>{formatTime(currentTime)}</strong>
            </div>
            <div className="timeline-readout">
              <span>Out</span>
              <strong>{formatTime(trim.end)}</strong>
            </div>
            <div className="timeline-readout">
              <span>Range</span>
              <strong>{formatTime(Math.max(0, trim.end - trim.start))}</strong>
            </div>
          </div>

          <div className="timeline-controls-row">
            <button className="tool-button tool-button--small" onClick={() => nudgeFrame(-1)} disabled={!video}>
              ← Frame
            </button>
            <button className="tool-button tool-button--small" onClick={setInPoint} disabled={!video}>
              Mark In
            </button>
            <button className="tool-button tool-button--small" onClick={setOutPoint} disabled={!video}>
              Mark Out
            </button>
            <button className="tool-button tool-button--small" onClick={() => nudgeFrame(1)} disabled={!video}>
              Frame →
            </button>
            <button className="tool-button tool-button--small" onClick={playTrimmedRange} disabled={!video}>
              Replay Range
            </button>
            <button className="tool-button tool-button--small" onClick={resetTrimRange} disabled={!video}>
              Reset
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="panel-label">Saved Selections</p>
              <h2>Clip set</h2>
            </div>
            <div className="panel-heading__meta">
              {savedSelections.length > 0 ? `${savedSelections.length} saved clips` : 'Save selections as you work'}
            </div>
          </div>

          <div className="selection-actions">
            <button
              className="tool-button tool-button--accent"
              onClick={() => void saveSelection('new')}
              disabled={!video || !normalizedCrop}
            >
              Save New Selection
            </button>
            <button
              className="tool-button"
              onClick={() => void saveSelection('update')}
              disabled={!activeSelectionId || !video || !normalizedCrop}
            >
              Update Selected
            </button>
          </div>

          {savedSelections.length > 0 ? (
            <div className="selection-grid">
              {savedSelections.map((selection) => {
                const exportClip = selectionExportClips.find((clip) => clip.id === selection.id)
                return (
                  <div
                    key={selection.id}
                    className={`selection-card ${selection.id === activeSelectionId ? 'selection-card--active' : ''}`}
                  >
                    <button className="selection-card__main" onClick={() => loadSelectionIntoEditor(selection)}>
                      <div
                        className="selection-card__thumb"
                        style={{ backgroundImage: `url(${selection.thumbnailUrl})` }}
                      />
                      <div className="selection-card__body">
                        <strong>{selection.name}</strong>
                        <span>
                          {formatTime(selection.trim.start)} - {formatTime(selection.trim.end)}
                        </span>
                        {exportClip ? (
                          <span>
                            {exportClip.scale.width} × {exportClip.scale.height}
                          </span>
                        ) : null}
                        {selection.upscaleQuality === 'high' ? <span>High-quality upscale</span> : null}
                      </div>
                    </button>
                    <button
                      className="selection-card__remove"
                      onClick={() => removeSelection(selection.id)}
                      aria-label={`Remove ${selection.name}`}
                    >
                      Remove
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="selection-empty">
              Save the current crop + trim state, then move somewhere else in the source and save another.
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="panel-label">Crop & Export</p>
              <h2>Framing</h2>
            </div>
            <div className="panel-heading__meta">
              {normalizedCrop ? getCropSummaryLabel(aspectPreset, aspectRatio) : 'Set crop after trim'}
            </div>
          </div>

          <div className="field-grid">
            <div className="field field--full">
              <span className="field-label">Crop aspect</span>
              <div className="toolbar toolbar--compact">
                {ASPECT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={`tool-button tool-button--small ${preset.id === aspectPreset ? 'tool-button--accent' : ''}`}
                    onClick={() => setAspectPreset(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="field field--toggle">
              <span className="field-label">Lock crop to selected aspect</span>
              <input
                type="checkbox"
                checked={ratioLocked}
                onChange={(event) => setRatioLocked(event.target.checked)}
              />
            </label>

            <label className="field field--toggle">
              <span className="field-label">Flip horizontal</span>
              <input
                type="checkbox"
                checked={flip.horizontal}
                onChange={(event) =>
                  setFlip((current) => ({
                    ...current,
                    horizontal: event.target.checked,
                  }))
                }
              />
            </label>

            <label className="field field--toggle">
              <span className="field-label">Flip vertical</span>
              <input
                type="checkbox"
                checked={flip.vertical}
                onChange={(event) =>
                  setFlip((current) => ({
                    ...current,
                    vertical: event.target.checked,
                  }))
                }
              />
            </label>

            <div className="field field--full">
              <span className="field-label">Export sizing</span>
              <div className="toolbar toolbar--compact">
                <button
                  className={`tool-button tool-button--small ${scaleMode === 'crop' ? 'tool-button--accent' : ''}`}
                  onClick={() => setScaleMode('crop')}
                  disabled={!normalizedCrop || simulatorExtend}
                >
                  Keep crop pixels
                </button>
                <button
                  className={`tool-button tool-button--small ${scaleMode === 'preset' ? 'tool-button--accent' : ''}`}
                  onClick={() => setScaleMode('preset')}
                  disabled={!normalizedCrop || simulatorExtend}
                >
                  {presetOutput?.label ?? 'Scale to preset frame'}
                </button>
              </div>
              {simulatorExtend ? (
                <span className="field-help">
                  Simulator extend overrides normal sizing and exports a 5760 × 1080 composite.
                </span>
              ) : null}
            </div>

            <div className="field field--full">
              <span className="field-label">Upscale quality</span>
              <div className="toolbar toolbar--compact">
                <button
                  className={`tool-button tool-button--small ${upscaleQuality === 'standard' ? 'tool-button--accent' : ''}`}
                  onClick={() => setUpscaleQuality('standard')}
                >
                  Standard
                </button>
                <button
                  className={`tool-button tool-button--small ${upscaleQuality === 'high' ? 'tool-button--accent' : ''}`}
                  onClick={() => setUpscaleQuality('high')}
                >
                  High quality
                </button>
              </div>
              <span className="field-help">
                High quality uses Lanczos scaling with light sharpening when the export is larger than the crop.
              </span>
              {simulatorExtend ? (
                <span className="field-help">
                  Simulator extend already uses Lanczos scaling for its stretched side fills.
                </span>
              ) : null}
            </div>

            <label className="field field--full field--toggle">
              <span className="field-label">Simulator extend export</span>
              <input
                type="checkbox"
                checked={simulatorExtend}
                onChange={(event) => handleSimulatorExtendChange(event.target.checked)}
                disabled={!normalizedCrop}
              />
              <span className="field-help">
                Export a 5760 × 1080 simulator frame with a 1920 × 1080 center image and blurred side-screen fill.
              </span>
              <span className="field-help">
                The center screen stays at standard 1920 × 1080 and the side screens use blurred edge fill.
              </span>
            </label>

            {savedSelections.length > 1 ? (
              <div className="field field--full">
                <span className="field-label">Selection export mode</span>
                <div className="toolbar toolbar--compact">
                  <button
                    className={`tool-button tool-button--small ${exportMode === 'continuous' ? 'tool-button--accent' : ''}`}
                    onClick={() => setExportMode('continuous')}
                    disabled={!continuousExportAvailable}
                  >
                    One continuous clip
                  </button>
                  <button
                    className={`tool-button tool-button--small ${exportMode === 'individual' ? 'tool-button--accent' : ''}`}
                    onClick={() => setExportMode('individual')}
                  >
                    Individual clips
                  </button>
                </div>
                {!continuousExportAvailable ? (
                  <span className="field-help">
                    Continuous export needs every saved selection to share the same output size.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="stat-grid stat-grid--after">
            <div>
              <span>Current crop in source pixels</span>
              <strong>
                {normalizedCrop
                  ? `${normalizedCrop.width} × ${normalizedCrop.height} @ ${normalizedCrop.x}, ${normalizedCrop.y}`
                  : 'No crop yet'}
              </strong>
            </div>
            <div>
              <span>Current export output</span>
              <strong>
                {selectedOutput ? `${selectedOutput.width} × ${selectedOutput.height}` : 'No output size'}
              </strong>
            </div>
            <div>
              <span>Export composition</span>
              <strong>{simulatorExtend ? 'Simulator extend 5760 × 1080' : 'Direct crop export'}</strong>
            </div>
            <div>
              <span>Upscale processing</span>
              <strong>{upscaleQuality === 'high' ? 'Lanczos + light sharpen' : 'Standard scaling'}</strong>
            </div>
          </div>

          <div className="export-actions">
            <button
              className="tool-button tool-button--accent"
              onClick={() => void handleExport()}
              disabled={
                !desktopRuntime ||
                isExporting ||
                (!video?.path || (!normalizedCrop && savedSelections.length <= 1)) ||
                (savedSelections.length > 1 && exportMode === 'continuous' && !continuousExportAvailable)
              }
            >
              {isExporting
                ? 'Exporting...'
                : savedSelections.length > 1
                  ? exportMode === 'continuous'
                    ? 'Export Continuous Sequence'
                    : `Export ${savedSelections.length} Clips`
                  : desktopRuntime
                    ? 'Export MP4'
                    : 'Export requires Tauri'}
            </button>
            {lastExportPath ? <span className="status-pill status-pill--ok">{lastExportPath}</span> : null}
          </div>

          {isExporting && exportProgress ? (
            <div className="export-progress" aria-live="polite">
              <div className="export-progress__header">
                <span>{exportProgress.stepLabel}</span>
                <span>{formatExportPercent(exportProgress.overallProgress)}</span>
              </div>
              <div
                className="export-progress__track"
                role="progressbar"
                aria-label="Export progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(clamp(exportProgress.overallProgress, 0, 1) * 100)}
              >
                <div
                  className="export-progress__fill"
                  style={{ width: `${Math.max(clamp(exportProgress.overallProgress, 0, 1) * 100, 2)}%` }}
                />
              </div>
              {exportProgress.totalSteps > 1 ? (
                <span className="export-progress__meta">
                  Step {exportProgress.currentStep} of {exportProgress.totalSteps}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="command-preview">
            <p className="field-label">Current ffmpeg command</p>
            <code>{exportCommand || 'Open a clip to generate the export command.'}</code>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
