// Video-processing helpers for explicit request wrappers.

import AVFoundation
import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Vision

internal func loadVideoURL(path: String) -> URL? {
    let url = URL(fileURLWithPath: path)
    return FileManager.default.fileExists(atPath: url.path) ? url : nil
}

internal func renderTextImage(text: String, width: Int, height: Int) -> CGImage? {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }

    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    let nsContext = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = nsContext
    let fontSize = CGFloat(height) * 0.4
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: fontSize, weight: .bold),
        .foregroundColor: NSColor.black,
    ]
    let attributed = NSAttributedString(string: text, attributes: attrs)
    let textSize = attributed.size()
    let drawX = (CGFloat(width) - textSize.width) / 2
    let drawY = (CGFloat(height) - textSize.height) / 2
    attributed.draw(at: NSPoint(x: drawX, y: drawY))
    NSGraphicsContext.restoreGraphicsState()

    return context.makeImage()
}

internal func makePixelBuffer(
    from image: CGImage,
    width: Int,
    height: Int,
    pool: CVPixelBufferPool?
) -> CVPixelBuffer? {
    let attrs: [CFString: Any] = [
        kCVPixelBufferCGImageCompatibilityKey: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height,
    ]

    var pixelBuffer: CVPixelBuffer?
    let status: CVReturn
    if let pool {
        status = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer)
    } else {
        status = CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pixelBuffer)
    }
    guard status == kCVReturnSuccess, let pixelBuffer else {
        return nil
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
    guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
        return nil
    }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Little.union(.init(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue))
    guard let context = CGContext(
        data: baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
        space: colorSpace,
        bitmapInfo: bitmapInfo.rawValue
    ) else {
        return nil
    }

    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return pixelBuffer
}

final class VideoTextCollector {
    private let lock = NSLock()
    private(set) var observations = [CollectedTextObservation]()
    private(set) var reportedError: Error?

    func append(_ newObservations: [CollectedTextObservation]) {
        lock.lock()
        observations.append(contentsOf: newObservations)
        lock.unlock()
    }

    func setError(_ error: Error) {
        lock.lock()
        if reportedError == nil {
            reportedError = error
        }
        lock.unlock()
    }
}

@_cdecl("vn_video_processor_analyze_text_request")
public func vn_video_processor_analyze_text_request(
    _ videoPath: UnsafePointer<CChar>,
    _ recognitionLevel: Int32,
    _ usesLanguageCorrection: Bool,
    _ preferBackgroundProcessing: Bool,
    _ usesCPUOnly: Bool,
    _ revision: Int,
    _ hasRevision: Bool,
    _ cadenceKind: Int32,
    _ cadenceValue: Double,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outArray.pointee = nil
    outCount.pointee = 0

    let path = String(cString: videoPath)
    guard let url = loadVideoURL(path: path) else {
        outErrorMessage?.pointee = ffiString("could not open video at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }

    let asset = AVURLAsset(url: url)
    let duration = asset.duration
    let durationSeconds = CMTimeGetSeconds(duration)
    guard durationSeconds.isFinite, durationSeconds > 0 else {
        outErrorMessage?.pointee = ffiString("video at \(path) has no finite duration")
        return VN_INVALID_ARGUMENT
    }

    let collector = VideoTextCollector()
    let request = buildRecognizeTextRequest(
        recognitionLevel: recognitionLevel,
        usesLanguageCorrection: usesLanguageCorrection,
        preferBackgroundProcessing: preferBackgroundProcessing,
        usesCPUOnly: usesCPUOnly,
        revision: revision,
        hasRevision: hasRevision,
        completionHandler: { request, error in
            if let error {
                collector.setError(error)
                return
            }
            let results = (request.results as? [VNRecognizedTextObservation]) ?? []
            collector.append(results.map(collectTextObservation))
        }
    )

    let processor = VNVideoProcessor(url: url)
    let options = VNVideoProcessor.RequestProcessingOptions()
    switch cadenceKind {
    case 1:
        options.cadence = VNVideoProcessor.FrameRateCadence(max(Int(cadenceValue), 1))
    case 2:
        options.cadence = VNVideoProcessor.TimeIntervalCadence(cadenceValue)
    default:
        break
    }

    do {
        try processor.addRequest(request, processingOptions: options)
        try processor.analyze(CMTimeRange(start: .zero, duration: duration))
        if let reportedError = collector.reportedError {
            throw reportedError
        }
    } catch {
        outErrorMessage?.pointee = ffiString("VNVideoProcessor.analyze(text) failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }

    packCollectedTextObservations(collector.observations, outArray: outArray, outCount: outCount)
    return VN_OK
}

@_cdecl("vn_test_helper_render_text_video")
public func vn_test_helper_render_text_video(
    _ firstText: UnsafePointer<CChar>,
    _ secondText: UnsafePointer<CChar>,
    _ width: Int32,
    _ height: Int32,
    _ fps: Int32,
    _ framesPerText: Int32,
    _ outputPath: UnsafePointer<CChar>
) -> Int32 {
    let texts = [String(cString: firstText), String(cString: secondText)]
    let url = URL(fileURLWithPath: String(cString: outputPath))
    let writerWidth = max(Int(width), 64)
    let writerHeight = max(Int(height), 64)
    let writerFPS = max(Int(fps), 1)
    let segmentFrames = max(Int(framesPerText), 1)

    if FileManager.default.fileExists(atPath: url.path) {
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            return VN_UNKNOWN
        }
    }

    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: writerWidth,
        AVVideoHeightKey: writerHeight,
    ]

    guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else {
        return VN_UNKNOWN
    }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: writerWidth,
            kCVPixelBufferHeightKey as String: writerHeight,
        ]
    )

    guard writer.canAdd(input) else { return VN_UNKNOWN }
    writer.add(input)
    guard writer.startWriting() else { return VN_UNKNOWN }
    writer.startSession(atSourceTime: .zero)

    var frameIndex = 0
    for text in texts {
        for _ in 0..<segmentFrames {
            guard let image = renderTextImage(text: text, width: writerWidth, height: writerHeight),
                  let pixelBuffer = makePixelBuffer(from: image, width: writerWidth, height: writerHeight, pool: adaptor.pixelBufferPool)
            else {
                writer.cancelWriting()
                return VN_UNKNOWN
            }
            while !input.isReadyForMoreMediaData {
                Thread.sleep(forTimeInterval: 0.001)
            }
            let presentationTime = CMTime(value: CMTimeValue(frameIndex), timescale: CMTimeScale(writerFPS))
            guard adaptor.append(pixelBuffer, withPresentationTime: presentationTime) else {
                writer.cancelWriting()
                return VN_UNKNOWN
            }
            frameIndex += 1
        }
    }

    input.markAsFinished()
    let finished = DispatchSemaphore(value: 0)
    writer.finishWriting {
        finished.signal()
    }
    finished.wait()
    return writer.status == .completed ? VN_OK : VN_UNKNOWN
}
