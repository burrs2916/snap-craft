// Explicit VNRequest / handler / video-processor wrappers.

import CoreGraphics
import CoreMedia
import Foundation
import Vision

@frozen
public struct VNRequestObservationRaw {
    public var uuid: UnsafeMutablePointer<CChar>?
    public var text: UnsafeMutablePointer<CChar>?
    public var confidence: Float
    public var has_time_range: Bool
    public var time_range_start_seconds: Double
    public var time_range_duration_seconds: Double
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
}

internal struct CollectedTextObservation {
    let uuid: String
    let text: String
    let confidence: Float
    let hasTimeRange: Bool
    let timeRangeStartSeconds: Double
    let timeRangeDurationSeconds: Double
    let boundingBox: CGRect
}

internal func collectTextObservation(_ observation: VNRecognizedTextObservation) -> CollectedTextObservation {
    let candidate = observation.topCandidates(1).first
    let start = CMTimeGetSeconds(observation.timeRange.start)
    let duration = CMTimeGetSeconds(observation.timeRange.duration)
    let hasTimeRange = start.isFinite && duration.isFinite
    return CollectedTextObservation(
        uuid: observation.uuid.uuidString,
        text: candidate?.string ?? "",
        confidence: observation.confidence,
        hasTimeRange: hasTimeRange,
        timeRangeStartSeconds: hasTimeRange ? start : 0,
        timeRangeDurationSeconds: hasTimeRange ? duration : 0,
        boundingBox: observation.boundingBox
    )
}

internal func packCollectedTextObservations(
    _ observations: [CollectedTextObservation],
    outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    outCount: UnsafeMutablePointer<Int>
) {
    guard !observations.isEmpty else {
        outArray.pointee = nil
        outCount.pointee = 0
        return
    }

    let buffer = UnsafeMutablePointer<VNRequestObservationRaw>.allocate(capacity: observations.count)
    for (index, observation) in observations.enumerated() {
        let bbox = observation.boundingBox
        buffer.advanced(by: index).initialize(to: VNRequestObservationRaw(
            uuid: ffiString(observation.uuid),
            text: ffiString(observation.text),
            confidence: observation.confidence,
            has_time_range: observation.hasTimeRange,
            time_range_start_seconds: observation.timeRangeStartSeconds,
            time_range_duration_seconds: observation.timeRangeDurationSeconds,
            bbox_x: Double(bbox.origin.x),
            bbox_y: Double(bbox.origin.y),
            bbox_w: Double(bbox.size.width),
            bbox_h: Double(bbox.size.height)
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buffer)
    outCount.pointee = observations.count
}

internal func buildRecognizeTextRequest(
    recognitionLevel: Int32,
    usesLanguageCorrection: Bool,
    preferBackgroundProcessing: Bool,
    usesCPUOnly: Bool,
    revision: Int,
    hasRevision: Bool,
    completionHandler: VNRequestCompletionHandler? = nil
) -> VNRecognizeTextRequest {
    let request: VNRecognizeTextRequest
    if let completionHandler {
        request = VNRecognizeTextRequest(completionHandler: completionHandler)
    } else {
        request = VNRecognizeTextRequest()
    }
    request.recognitionLevel = recognitionLevel == 1 ? .accurate : .fast
    request.usesLanguageCorrection = usesLanguageCorrection
    request.preferBackgroundProcessing = preferBackgroundProcessing
    request.usesCPUOnly = usesCPUOnly
    if hasRevision {
        request.revision = revision
    }
    return request
}

internal func applyImageBasedRequestConfig(
    _ request: VNImageBasedRequest,
    roiX: Double,
    roiY: Double,
    roiW: Double,
    roiH: Double,
    hasRegionOfInterest: Bool,
    preferBackgroundProcessing: Bool,
    usesCPUOnly: Bool,
    revision: Int,
    hasRevision: Bool
) {
    if hasRegionOfInterest {
        request.regionOfInterest = CGRect(x: roiX, y: roiY, width: roiW, height: roiH)
    }
    request.preferBackgroundProcessing = preferBackgroundProcessing
    request.usesCPUOnly = usesCPUOnly
    if hasRevision {
        request.revision = revision
    }
}

@_cdecl("vn_image_request_handler_perform_text_request")
public func vn_image_request_handler_perform_text_request(
    _ imagePath: UnsafePointer<CChar>,
    _ recognitionLevel: Int32,
    _ usesLanguageCorrection: Bool,
    _ preferBackgroundProcessing: Bool,
    _ usesCPUOnly: Bool,
    _ revision: Int,
    _ hasRevision: Bool,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let path = String(cString: imagePath)
    guard let cgImage = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = buildRecognizeTextRequest(
        recognitionLevel: recognitionLevel,
        usesLanguageCorrection: usesLanguageCorrection,
        preferBackgroundProcessing: preferBackgroundProcessing,
        usesCPUOnly: usesCPUOnly,
        revision: revision,
        hasRevision: hasRevision
    )

    do {
        try handler.perform([request])
    } catch {
        outErrorMessage?.pointee = ffiString("VNImageRequestHandler.perform(text) failed: \(error.localizedDescription)")
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_REQUEST_FAILED
    }

    let observations = (request.results ?? []).map(collectTextObservation)
    packCollectedTextObservations(observations, outArray: outArray, outCount: outCount)
    return VN_OK
}

final class TextSequenceRequestHandlerSession {
    private let handler = VNSequenceRequestHandler()

    func perform(
        path: String,
        recognitionLevel: Int32,
        usesLanguageCorrection: Bool,
        preferBackgroundProcessing: Bool,
        usesCPUOnly: Bool,
        revision: Int,
        hasRevision: Bool
    ) throws -> [CollectedTextObservation] {
        guard let cgImage = loadCGImage(path: path) else {
            throw NSError(domain: "apple-vision", code: Int(VN_IMAGE_LOAD_FAILED), userInfo: [NSLocalizedDescriptionKey: "could not load image at \(path)"])
        }

        let request = buildRecognizeTextRequest(
            recognitionLevel: recognitionLevel,
            usesLanguageCorrection: usesLanguageCorrection,
            preferBackgroundProcessing: preferBackgroundProcessing,
            usesCPUOnly: usesCPUOnly,
            revision: revision,
            hasRevision: hasRevision
        )
        try handler.perform([request], on: cgImage)
        return (request.results ?? []).map(collectTextObservation)
    }
}

@_cdecl("vn_sequence_request_handler_create")
public func vn_sequence_request_handler_create(
    _ outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outErrorMessage?.pointee = nil
    outHandle.pointee = Unmanaged.passRetained(TextSequenceRequestHandlerSession()).toOpaque()
    return VN_OK
}

@_cdecl("vn_sequence_request_handler_perform_text_request")
public func vn_sequence_request_handler_perform_text_request(
    _ handle: UnsafeMutableRawPointer?,
    _ imagePath: UnsafePointer<CChar>,
    _ recognitionLevel: Int32,
    _ usesLanguageCorrection: Bool,
    _ preferBackgroundProcessing: Bool,
    _ usesCPUOnly: Bool,
    _ revision: Int,
    _ hasRevision: Bool,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outArray.pointee = nil
    outCount.pointee = 0
    guard let handle else {
        outErrorMessage?.pointee = ffiString("null sequence request handler handle")
        return VN_INVALID_ARGUMENT
    }

    let session = Unmanaged<TextSequenceRequestHandlerSession>.fromOpaque(handle).takeUnretainedValue()
    let path = String(cString: imagePath)
    do {
        let observations = try session.perform(
            path: path,
            recognitionLevel: recognitionLevel,
            usesLanguageCorrection: usesLanguageCorrection,
            preferBackgroundProcessing: preferBackgroundProcessing,
            usesCPUOnly: usesCPUOnly,
            revision: revision,
            hasRevision: hasRevision
        )
        packCollectedTextObservations(observations, outArray: outArray, outCount: outCount)
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("VNSequenceRequestHandler.perform(text) failed: \(error.localizedDescription)")
        return (error as NSError).code == Int(VN_IMAGE_LOAD_FAILED) ? VN_IMAGE_LOAD_FAILED : VN_REQUEST_FAILED
    }
}

@_cdecl("vn_sequence_request_handler_free")
public func vn_sequence_request_handler_free(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    Unmanaged<TextSequenceRequestHandlerSession>.fromOpaque(handle).release()
}

@_cdecl("vn_request_observations_free")
public func vn_request_observations_free(
    _ array: UnsafeMutableRawPointer?,
    _ count: Int
) {
    guard let array else { return }
    let typed = array.assumingMemoryBound(to: VNRequestObservationRaw.self)
    for index in 0..<count {
        let observation = typed.advanced(by: index).pointee
        if let uuid = observation.uuid {
            free(uuid)
        }
        if let text = observation.text {
            free(text)
        }
    }
    typed.deallocate()
}

