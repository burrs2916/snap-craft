// Stateful tracking helpers plus object/rectangle trackers.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

internal func mkRectangleRaw(_ obs: VNRectangleObservation) -> VNRectangleObservationRaw {
    let b = obs.boundingBox
    return VNRectangleObservationRaw(
        bbox_x: Double(b.origin.x),
        bbox_y: Double(b.origin.y),
        bbox_w: Double(b.size.width),
        bbox_h: Double(b.size.height),
        confidence: obs.confidence,
        tl_x: Double(obs.topLeft.x),
        tl_y: Double(obs.topLeft.y),
        tr_x: Double(obs.topRight.x),
        tr_y: Double(obs.topRight.y),
        bl_x: Double(obs.bottomLeft.x),
        bl_y: Double(obs.bottomLeft.y),
        br_x: Double(obs.bottomRight.x),
        br_y: Double(obs.bottomRight.y)
    )
}

internal func mkRectangleObservation(_ raw: VNRectangleObservationRaw) -> VNRectangleObservation {
    let tl = CGPoint(x: raw.tl_x, y: raw.tl_y)
    let tr = CGPoint(x: raw.tr_x, y: raw.tr_y)
    let br = CGPoint(x: raw.br_x, y: raw.br_y)
    let bl = CGPoint(x: raw.bl_x, y: raw.bl_y)
    if #available(macOS 14.0, *) {
        return VNRectangleObservation(
            requestRevision: VNRequestRevisionUnspecified,
            topLeft: tl,
            topRight: tr,
            bottomRight: br,
            bottomLeft: bl
        )
    }
    return VNRectangleObservation(
        requestRevision: VNRequestRevisionUnspecified,
        topLeft: tl,
        bottomLeft: bl,
        bottomRight: br,
        topRight: tr
    )
}

internal func copyTrackedPixelBuffer(_ buffer: CVPixelBuffer) -> VNSegmentationMaskRaw {
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else {
        return VNSegmentationMaskRaw(width: width, height: height, bytes_per_row: bytesPerRow, bytes: nil)
    }
    let size = height * bytesPerRow
    let out = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
    memcpy(out, base, size)
    return VNSegmentationMaskRaw(width: width, height: height, bytes_per_row: bytesPerRow, bytes: out)
}

internal func isTimestampRequirementError(_ error: Error) -> Bool {
    let msg = error.localizedDescription.lowercased()
    return msg.contains("timestamp") || msg.contains("presentationtimestamp") || msg.contains("pts")
}

@frozen
public struct VNIdentityHomographicAlignmentRaw {
    public static let value = VNHomographicAlignmentRaw(
        m00: 1, m01: 0, m02: 0,
        m10: 0, m11: 1, m12: 0,
        m20: 0, m21: 0, m22: 1,
        _pad: 0
    )
}

final class ObjectTrackerSession {
    private let handler = VNSequenceRequestHandler()
    private let request: VNTrackObjectRequest
    private var lastObservation: VNDetectedObjectObservation

    init(initialImage: CGImage, initialBoundingBox: VNSimpleRectRaw) throws {
        let rect = CGRect(x: initialBoundingBox.x, y: initialBoundingBox.y,
                          width: initialBoundingBox.w, height: initialBoundingBox.h)
        let observation = VNDetectedObjectObservation(boundingBox: rect)
        request = VNTrackObjectRequest(detectedObjectObservation: observation)
        request.trackingLevel = .accurate
        lastObservation = observation
        try handler.perform([request], on: initialImage)
        if let tracked = request.results?.first as? VNDetectedObjectObservation {
            lastObservation = tracked
            request.inputObservation = tracked
        }
    }

    func track(nextImage: CGImage) throws -> VNSimpleRectRaw {
        try handler.perform([request], on: nextImage)
        if let tracked = request.results?.first as? VNDetectedObjectObservation {
            lastObservation = tracked
            request.inputObservation = tracked
        }
        return mkRect(lastObservation.boundingBox, lastObservation.confidence)
    }
}

final class RectangleTrackerSession {
    private let handler = VNSequenceRequestHandler()
    private let request: VNTrackRectangleRequest
    private var lastObservation: VNRectangleObservation

    init(initialImage: CGImage, initialObservation: VNRectangleObservationRaw) throws {
        let rectangleObservation = mkRectangleObservation(initialObservation)
        request = VNTrackRectangleRequest(rectangleObservation: rectangleObservation)
        request.trackingLevel = .accurate
        lastObservation = rectangleObservation
        try handler.perform([request], on: initialImage)
        if let tracked = request.results?.first as? VNRectangleObservation {
            lastObservation = tracked
            request.inputObservation = tracked
        }
    }

    func track(nextImage: CGImage) throws -> VNRectangleObservationRaw {
        try handler.perform([request], on: nextImage)
        if let tracked = request.results?.first as? VNRectangleObservation {
            lastObservation = tracked
            request.inputObservation = tracked
        }
        return mkRectangleRaw(lastObservation)
    }
}

@available(macOS 14.0, *)
final class OpticalFlowTrackerSession {
    private let sequenceHandler = VNSequenceRequestHandler()
    private let request = VNTrackOpticalFlowRequest()
    private var usesImageHandlers = false

    init(referenceImage: CGImage) throws {
        request.computationAccuracy = .medium
        request.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float
        try perform(on: referenceImage)
    }

    private func perform(on image: CGImage) throws {
        if usesImageHandlers {
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            try handler.perform([request])
            return
        }
        do {
            try sequenceHandler.perform([request], on: image)
        } catch {
            if isTimestampRequirementError(error) {
                usesImageHandlers = true
                let handler = VNImageRequestHandler(cgImage: image, options: [:])
                try handler.perform([request])
                return
            }
            throw error
        }
    }

    func track(nextImage: CGImage) throws -> VNSegmentationMaskRaw {
        try perform(on: nextImage)
        guard let observation = request.results?.first else {
            return VNSegmentationMaskRaw(width: 0, height: 0, bytes_per_row: 0, bytes: nil)
        }
        return copyTrackedPixelBuffer(observation.pixelBuffer)
    }
}

@available(macOS 14.0, *)
final class TranslationalImageTrackerSession {
    private let sequenceHandler = VNSequenceRequestHandler()
    private let request = VNTrackTranslationalImageRegistrationRequest()
    private var usesImageHandlers = false

    init(referenceImage: CGImage) throws {
        try perform(on: referenceImage)
    }

    private func perform(on image: CGImage) throws {
        if usesImageHandlers {
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            try handler.perform([request])
            return
        }
        do {
            try sequenceHandler.perform([request], on: image)
        } catch {
            if isTimestampRequirementError(error) {
                usesImageHandlers = true
                let handler = VNImageRequestHandler(cgImage: image, options: [:])
                try handler.perform([request])
                return
            }
            throw error
        }
    }

    func track(nextImage: CGImage) throws -> VNTranslationalAlignmentRaw {
        try perform(on: nextImage)
        guard let observation = request.results?.first else {
            return VNTranslationalAlignmentRaw(tx: 0, ty: 0)
        }
        return VNTranslationalAlignmentRaw(
            tx: Double(observation.alignmentTransform.tx),
            ty: Double(observation.alignmentTransform.ty)
        )
    }
}

@available(macOS 14.0, *)
final class HomographicImageTrackerSession {
    private let sequenceHandler = VNSequenceRequestHandler()
    private let request = VNTrackHomographicImageRegistrationRequest()
    private var usesImageHandlers = false

    init(referenceImage: CGImage) throws {
        try perform(on: referenceImage)
    }

    private func perform(on image: CGImage) throws {
        if usesImageHandlers {
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            try handler.perform([request])
            return
        }
        do {
            try sequenceHandler.perform([request], on: image)
        } catch {
            if isTimestampRequirementError(error) {
                usesImageHandlers = true
                let handler = VNImageRequestHandler(cgImage: image, options: [:])
                try handler.perform([request])
                return
            }
            throw error
        }
    }

    func track(nextImage: CGImage) throws -> VNHomographicAlignmentRaw {
        try perform(on: nextImage)
        guard let observation = request.results?.first else {
            return VNIdentityHomographicAlignmentRaw.value
        }
        let m = observation.warpTransform
        return VNHomographicAlignmentRaw(
            m00: m.columns.0.x, m01: m.columns.0.y, m02: m.columns.0.z,
            m10: m.columns.1.x, m11: m.columns.1.y, m12: m.columns.1.z,
            m20: m.columns.2.x, m21: m.columns.2.y, m22: m.columns.2.z,
            _pad: 0
        )
    }
}

@_cdecl("vn_object_tracker_create")
public func vn_object_tracker_create(
    _ initialPath: UnsafePointer<CChar>,
    _ initialBoundingBoxRaw: UnsafeMutableRawPointer?,
    _ outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outHandle.pointee = nil
    guard let initialBoundingBoxRaw else {
        outErrorMessage?.pointee = ffiString("missing initial bounding box")
        return VN_INVALID_ARGUMENT
    }
    let initialBoundingBox = initialBoundingBoxRaw.assumingMemoryBound(to: VNSimpleRectRaw.self)
    let path = String(cString: initialPath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    do {
        let tracker = try ObjectTrackerSession(initialImage: image, initialBoundingBox: initialBoundingBox.pointee)
        outHandle.pointee = Unmanaged.passRetained(tracker).toOpaque()
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("object tracker create failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_object_tracker_track")
public func vn_object_tracker_track(
    _ handle: UnsafeMutableRawPointer?,
    _ nextPath: UnsafePointer<CChar>,
    _ outBoundingBoxRaw: UnsafeMutableRawPointer,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outBoundingBox = outBoundingBoxRaw.assumingMemoryBound(to: VNSimpleRectRaw.self)
    outBoundingBox.pointee = VNSimpleRectRaw(x: 0, y: 0, w: 0, h: 0, confidence: 0, _pad: 0)
    guard let handle else {
        outErrorMessage?.pointee = ffiString("null object tracker handle")
        return VN_INVALID_ARGUMENT
    }
    let path = String(cString: nextPath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    let tracker = Unmanaged<ObjectTrackerSession>.fromOpaque(handle).takeUnretainedValue()
    do {
        outBoundingBox.pointee = try tracker.track(nextImage: image)
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("object tracker track failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_object_tracker_release")
public func vn_object_tracker_release(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    Unmanaged<ObjectTrackerSession>.fromOpaque(handle).release()
}

@_cdecl("vn_rectangle_tracker_create")
public func vn_rectangle_tracker_create(
    _ initialPath: UnsafePointer<CChar>,
    _ initialObservationRaw: UnsafeMutableRawPointer?,
    _ outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outHandle.pointee = nil
    guard let initialObservationRaw else {
        outErrorMessage?.pointee = ffiString("missing initial rectangle observation")
        return VN_INVALID_ARGUMENT
    }
    let initialObservation = initialObservationRaw.assumingMemoryBound(to: VNRectangleObservationRaw.self)
    let path = String(cString: initialPath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    do {
        let tracker = try RectangleTrackerSession(initialImage: image, initialObservation: initialObservation.pointee)
        outHandle.pointee = Unmanaged.passRetained(tracker).toOpaque()
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("rectangle tracker create failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_rectangle_tracker_track")
public func vn_rectangle_tracker_track(
    _ handle: UnsafeMutableRawPointer?,
    _ nextPath: UnsafePointer<CChar>,
    _ outObservationRaw: UnsafeMutableRawPointer,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outObservation = outObservationRaw.assumingMemoryBound(to: VNRectangleObservationRaw.self)
    outObservation.pointee = VNRectangleObservationRaw(
        bbox_x: 0, bbox_y: 0, bbox_w: 0, bbox_h: 0, confidence: 0,
        tl_x: 0, tl_y: 0, tr_x: 0, tr_y: 0,
        bl_x: 0, bl_y: 0, br_x: 0, br_y: 0
    )
    guard let handle else {
        outErrorMessage?.pointee = ffiString("null rectangle tracker handle")
        return VN_INVALID_ARGUMENT
    }
    let path = String(cString: nextPath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    let tracker = Unmanaged<RectangleTrackerSession>.fromOpaque(handle).takeUnretainedValue()
    do {
        outObservation.pointee = try tracker.track(nextImage: image)
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("rectangle tracker track failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_rectangle_tracker_release")
public func vn_rectangle_tracker_release(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    Unmanaged<RectangleTrackerSession>.fromOpaque(handle).release()
}
